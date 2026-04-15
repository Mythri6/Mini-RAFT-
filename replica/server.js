const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const storage = require('./storage');
const REPLICA_ID = process.env.REPLICA_ID || 1;
const PORT = process.env.PORT || 8081;
const NODE_ID = `replica-${REPLICA_ID}`;

const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '150', 10);
const ELECTION_TIMEOUT_MIN_MS = parseInt(process.env.ELECTION_TIMEOUT_MIN_MS || '500', 10);
const ELECTION_TIMEOUT_MAX_MS = parseInt(process.env.ELECTION_TIMEOUT_MAX_MS || '800', 10);

const clusterNodes = [
    'http://replica1:8081',
    'http://replica2:8082',
    'http://replica3:8083'
];

// BONUS CHALLENGE: Network Partition Simulator
let isNetworkPartitioned = false;

// --- RAFT STATE ---
// All nodes start as followers and participate in election.
const persisted = storage.loadData();
let state = 'FOLLOWER';
let currentTerm = persisted.currentTerm || 0;
let votedFor = persisted.votedFor || null;

// Uses Dictionaries to track multiple rooms
let roomLogs = persisted.log || {};
let roomCommitIndices = {};

let electionTimer = null;
let heartbeatTimer = null;

// The addresses of the other nodes so the Leader knows who to send data to
const followers = clusterNodes.filter(url => !url.endsWith(`:${PORT}`));

function persistState() {
    storage.saveState(currentTerm, roomLogs, votedFor);
}

function randomElectionTimeoutMs() {
    const min = Math.min(ELECTION_TIMEOUT_MIN_MS, ELECTION_TIMEOUT_MAX_MS);
    const max = Math.max(ELECTION_TIMEOUT_MIN_MS, ELECTION_TIMEOUT_MAX_MS);
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function stopHeartbeatLoop() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

function resetElectionTimer() {
    if (electionTimer) {
        clearTimeout(electionTimer);
        electionTimer = null;
    }

    if (state === 'LEADER') {
        return;
    }

    electionTimer = setTimeout(() => {
        startElection().catch((error) => {
            console.log(`[Replica ${REPLICA_ID}] Election error: ${error.message}`);
            resetElectionTimer();
        });
    }, randomElectionTimeoutMs());
}

function stepDown(nextTerm) {
    if (nextTerm > currentTerm) {
        currentTerm = nextTerm;
        votedFor = null;
        persistState();
    }

    if (state !== 'FOLLOWER') {
        state = 'FOLLOWER';
        stopHeartbeatLoop();
    }

    resetElectionTimer();
}

async function sendHeartbeats() {
    if (state !== 'LEADER') {
        return;
    }

    const payload = {
        term: currentTerm,
        leaderId: NODE_ID
    };

    await Promise.all(followers.map(async (followerUrl) => {
        try {
            const response = await axios.post(`${followerUrl}/heartbeat`, payload, { timeout: 500 });
            if (response.data && response.data.term > currentTerm) {
                stepDown(response.data.term);
            }
        } catch {
            // Follower may be down; election will happen only if majority cannot sustain leadership.
        }
    }));
}

function startHeartbeatLoop() {
    stopHeartbeatLoop();
    void sendHeartbeats();
    heartbeatTimer = setInterval(() => {
        void sendHeartbeats();
    }, HEARTBEAT_INTERVAL_MS);
}

async function startElection() {
    if (state === 'LEADER') {
        return;
    }

    state = 'CANDIDATE';
    currentTerm += 1;
    votedFor = NODE_ID;
    persistState();

    let votes = 1;
    const termAtStart = currentTerm;
    const majority = Math.floor(clusterNodes.length / 2) + 1;

    await Promise.all(followers.map(async (followerUrl) => {
        try {
            const response = await axios.post(`${followerUrl}/request-vote`, {
                term: termAtStart,
                candidateId: NODE_ID
            }, { timeout: 500 });

            const data = response.data || {};
            if (data.term > currentTerm) {
                stepDown(data.term);
                return;
            }

            if (state === 'CANDIDATE' && currentTerm === termAtStart && data.voteGranted) {
                votes += 1;
            }
        } catch {
            // Ignore unreachable followers during election.
        }
    }));

    if (state !== 'CANDIDATE' || currentTerm !== termAtStart) {
        if (state !== 'LEADER') {
            resetElectionTimer();
        }
        return;
    }

    if (votes >= majority) {
        state = 'LEADER';
        if (electionTimer) {
            clearTimeout(electionTimer);
            electionTimer = null;
        }
        console.log(`[Replica ${REPLICA_ID}] Became LEADER for term ${currentTerm}`);
        startHeartbeatLoop();
        return;
    }

    state = 'FOLLOWER';
    resetElectionTimer();
}

// ENDPOINT 1: Catch data from Gateway (Leader Only)
app.post('/client-stroke', async (req, res) => {
    if (state !== 'LEADER') {
        return res.status(400).json({ success: false, message: "I am not the leader." });
    }

    const newStroke = req.body;
    const roomId = newStroke.roomId;

    // If this room doesn't exist in memory yet, create it
    if (!roomLogs[roomId]) {
        roomLogs[roomId] = [];
        roomCommitIndices[roomId] = 0;
    }

    // If the room has more than 10,000 strokes, silently delete the oldest one
    if (roomLogs[roomId].length > 10000) {
        roomLogs[roomId].shift(); // Removes the very first item in the array
    }

    roomLogs[roomId].push(newStroke);
    persistState();
    const prevLogIndex = roomLogs[roomId].length - 2;

    console.log(`[Replica ${REPLICA_ID}] Leader received stroke. Log size for ${roomId}: ${roomLogs[roomId].length}`);
    
    // 1. Package the data
    const payload = {
        term: currentTerm,
        leaderId: `replica-${REPLICA_ID}`,
        roomId: roomId, // NEW: Tell the followers WHICH room this is for
        prevLogIndex: prevLogIndex,
        entries: [newStroke],
        leaderCommitIndex: roomCommitIndices[roomId]
    };

    let successCount = 1; // Count ourselves (the Leader) as 1 success

    // 2. Broadcast to Followers and handle Catch-Up
    const syncPromises = followers.map(async (followerUrl) => {
        try {
            // Add { timeout: 1000 }
            const response = await axios.post(`${followerUrl}/append-entries`, payload, { timeout: 1000 });
            
            if (response.data.success) {
                console.log(`[Replica ${REPLICA_ID}] Successfully synced stroke to ${followerUrl}`);
                successCount++; // Add their vote!
            } 
            else if (response.data.missingData) {
                // THE CATCH-UP PROTOCOL 
                console.log(`[Replica ${REPLICA_ID}] ${followerUrl} needs catch-up! Sending missing data...`);
                
                // Slice out the exact strokes the follower is missing
                const missingStrokes = roomLogs[roomId].slice(response.data.followerLogLength);
                
                try {
                    // Force-feed the missing strokes
                    await axios.post(`${followerUrl}/append-entries`, {
                        term: currentTerm,
                        leaderId: `replica-${REPLICA_ID}`,
                        roomId: roomId, 
                        prevLogIndex: response.data.followerLogLength - 1,
                        entries: missingStrokes,
                        leaderCommitIndex: roomCommitIndices[roomId]
                    }, { timeout: 1000 }); // Add { timeout: 1000 } here too
                    
                    console.log(`[Replica ${REPLICA_ID}] Successfully caught up ${followerUrl}!`);
                    successCount++; // Now their vote counts!
                } catch (e) {
                    console.log(`[Replica ${REPLICA_ID}] Catch-up failed for ${followerUrl}`);
                }
            }
        } catch (error) {
            console.log(`[Replica ${REPLICA_ID}] ⚠️ Cannot reach ${followerUrl}`);
        }
    });

    // 3. Wait for all followers to reply
    await Promise.all(syncPromises);

    // 4. MAJORITY RULE
    if (successCount >= 2) {
        roomCommitIndices[roomId] = roomLogs[roomId].length - 1; 
        console.log(`[Replica ${REPLICA_ID}] MAJORITY REACHED. Stroke committed at index ${roomCommitIndices[roomId]}.`);
        
        // Broadcast back to Gateway so the rest of the room sees it
        /* try {
            await axios.post('http://gateway:3000/broadcast', newStroke);
        } catch (e) {} */

        res.json({ success: true, message: "Stroke committed to cluster" });
    } else {
        console.log(`[Replica ${REPLICA_ID}] MAJORITY FAILED. Stroke discarded.`);
        
        // Find the exact failed object in memory and cleanly extract it
        const failedIndex = roomLogs[roomId].indexOf(newStroke);
        if (failedIndex > -1) {
            roomLogs[roomId].splice(failedIndex, 1); 
            persistState();
        }
        
        res.status(500).json({ success: false, message: "Cluster failed to reach consensus" });
    }
});

// ENDPOINT 2: Followers receive data from Leader
app.post('/append-entries', (req, res) => {

    if (isNetworkPartitioned) {
        // Return a simulated network timeout error
        return res.status(503).json({ error: "Network unreachable" }); 
    }

    const { term, roomId, prevLogIndex, entries, leaderCommitIndex } = req.body;

    // Reject if the leader's term is outdated
    if (term < currentTerm) {
        return res.json({ success: false, term: currentTerm });
    }

    if (term > currentTerm) {
        currentTerm = term;
        votedFor = null;
        persistState();
    }

    if (state !== 'FOLLOWER') {
        state = 'FOLLOWER';
        stopHeartbeatLoop();
    }

    resetElectionTimer();

    // If this room doesn't exist in memory yet, create it
    if (!roomLogs[roomId]) {
        roomLogs[roomId] = [];
        roomCommitIndices[roomId] = 0;
    }

    // THE CATCH-UP CHECK
    if (prevLogIndex >= 0 && !roomLogs[roomId][prevLogIndex]) {
        console.log(`[Replica ${REPLICA_ID}] WAIT! I am missing older strokes. Rejecting!`);
        // Tell the leader exactly how many strokes we currently have
        return res.json({ 
            success: false, 
            missingData: true, 
            followerLogLength: roomLogs[roomId].length 
        }); 
    }

    // Safely apply the strokes to the EXACT index (Fixes concurrent network races)
    if (entries && entries.length > 0) {
        // RAFT Rule: Slice off any conflicting future logs, then append the Leader's truth
        roomLogs[roomId].splice(prevLogIndex + 1); 
        roomLogs[roomId].push(...entries);
        persistState();
        console.log(`[Replica ${REPLICA_ID}] Follower saved stroke! Log size: ${roomLogs[roomId].length}`);
    }

    // Keep the commit index synced with the Leader
    if (leaderCommitIndex > roomCommitIndices[roomId]) {
        roomCommitIndices[roomId] = Math.min(leaderCommitIndex, roomLogs[roomId].length - 1);
    }

    res.json({ success: true });
});

app.post('/heartbeat', (req, res) => {

    if (isNetworkPartitioned) {
        // Return a simulated network timeout error
        return res.status(503).json({ error: "Network unreachable" }); 
    }

    const { term } = req.body;

    if (term < currentTerm) {
        return res.json({ success: false, term: currentTerm });
    }

    if (term > currentTerm) {
        currentTerm = term;
        votedFor = null;
        persistState();
    }

    if (state !== 'FOLLOWER') {
        state = 'FOLLOWER';
        stopHeartbeatLoop();
    }

    resetElectionTimer();
    res.json({ success: true, term: currentTerm });
});

app.post('/request-vote', (req, res) => {

    if (isNetworkPartitioned) {
        // Return a simulated network timeout error
        return res.status(503).json({ error: "Network unreachable" }); 
    }
    
    const { term, candidateId } = req.body;

    if (typeof term !== 'number' || !candidateId) {
        return res.status(400).json({ voteGranted: false, term: currentTerm });
    }

    if (term < currentTerm) {
        return res.json({ voteGranted: false, term: currentTerm });
    }

    if (term > currentTerm) {
        currentTerm = term;
        votedFor = null;
        if (state !== 'FOLLOWER') {
            state = 'FOLLOWER';
            stopHeartbeatLoop();
        }
        persistState();
    }

        if (votedFor !== null && votedFor !== candidateId) {
            resetElectionTimer();
        return res.json({ voteGranted: false, term: currentTerm });
    }

    votedFor = candidateId;
    persistState();
    resetElectionTimer();
    res.json({ voteGranted: true, term: currentTerm });
});

// Delete the room from memory to save RAM
app.delete('/room/:roomId', (req, res) => {
    const roomId = req.params.roomId;
    delete roomLogs[roomId];
    delete roomCommitIndices[roomId];
    persistState(); 
    
    // THE FIX: Tell the followers to delete the room!
    if (state === 'LEADER') {
        followers.forEach(followerUrl => {
            axios.delete(`${followerUrl}/room/${roomId}`).catch(() => {});
        });
    }
    console.log(`[Replica ${REPLICA_ID}] Room ${roomId} deleted from memory.`);
    res.json({ success: true });
});

// ENDPOINT 3: For the "Latecomer" Bug
// Sends the entire canvas history when someone new joins
app.get('/canvas/:roomId', (req, res) => {
    const roomId = req.params.roomId;
    // Explicitly tell the Gateway if this room exists in our database
    res.json({ 
        exists: roomLogs.hasOwnProperty(roomId), 
        log: roomLogs[roomId] || [] 
    });
});

// Wipe Canvas History
app.delete('/canvas/:roomId', (req, res) => {
    const roomId = req.params.roomId;
    if (roomLogs[roomId]) {
        roomLogs[roomId] = []; 
        persistState(); 
        
        // Tell the followers to wipe it too
        if (state === 'LEADER') {
            followers.forEach(followerUrl => {
                axios.delete(`${followerUrl}/canvas/${roomId}`).catch(() => {});
            });
        }
        console.log(`[Replica ${REPLICA_ID}] Cleared history for room ${roomId}`);
    }
    res.json({ success: true });
});

// The True Undo Feature (With Cluster Sync)
app.delete('/undo/:roomId/:userName', (req, res) => {
    const { roomId, userName } = req.params;
    if (!roomLogs[roomId] || roomLogs[roomId].length === 0) {
        return res.json({ success: false });
    }

    // 1. Find the ID of the last stroke batch drawn by this user
    let targetStrokeId = null;
    for (let i = roomLogs[roomId].length - 1; i >= 0; i--) {
        if (roomLogs[roomId][i].userName === userName) {
            targetStrokeId = roomLogs[roomId][i].strokeId;
            break;
        }
    }

    if (!targetStrokeId) return res.json({ success: false });

    // 2. Filter out ALL segments that belong to that batch locally!
    roomLogs[roomId] = roomLogs[roomId].filter(stroke => stroke.strokeId !== targetStrokeId);
    persistState();

    // 3. THE FIX: If I am the Leader, tell the Followers to delete it too
    if (state === 'LEADER') {
        followers.forEach(followerUrl => {
            // Fire a quick message to the followers so they wipe it from their RAM
            axios.delete(`${followerUrl}/undo/${roomId}/${userName}`).catch(() => {});
        });
    }
    
    console.log(`[Replica ${REPLICA_ID}] Undid full stroke batch for ${userName}`);
    res.json({ success: true });
});

// --- ROLE 4: STATUS API ---
app.get('/status', (req, res) => {
    // Upgraded to show the number of active rooms instead of array length
    res.json({
        replicaId: REPLICA_ID,
        state,
        currentTerm,
        votedFor,
        activeRooms: Object.keys(roomLogs).length,
        totalLogs: Object.values(roomLogs).reduce((acc, logs) => acc + logs.length, 0)
    });
});

app.post('/toggle-partition', (req, res) => {
    isNetworkPartitioned = !isNetworkPartitioned;
    console.log(`[Replica ${REPLICA_ID}] Network Partition: ${isNetworkPartitioned ? 'ACTIVE (Cut off)' : 'RESOLVED (Reconnected)'}`);
    res.json({ partitioned: isNetworkPartitioned });
});

app.listen(PORT, () => {
    console.log(`Replica ${REPLICA_ID} running on port ${PORT} as ${state}`);
    resetElectionTimer();
});
