const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const REPLICA_ID = process.env.REPLICA_ID || 1;
const PORT = process.env.PORT || 8081;

// --- RAFT STATE ---
// For now, we force Replica 1 to act as the Leader
let state = REPLICA_ID == 1 ? 'LEADER' : 'FOLLOWER'; 
let currentTerm = 0;

// --- YOUR VARIABLES (Role 3) ---
// UPGRADE: Changed from single arrays to Dictionaries to track multiple rooms!
let roomLogs = {}; 
let roomCommitIndices = {};

// The addresses of the other nodes so the Leader knows who to send data to
const followers = [
    'http://replica1:8081',
    'http://replica2:8082',
    'http://replica3:8083'
].filter(url => !url.includes(PORT)); // Remove myself from the list

// --- ENDPOINT 1: Catch data from Gateway (Leader Only) ---
app.post('/client-stroke', async (req, res) => {
    if (state !== 'LEADER') {
        return res.status(400).json({ success: false, message: "I am not the leader." });
    }

    const newStroke = req.body;
    const roomId = newStroke.roomId;

    // If this room doesn't exist in our memory yet, create it!
    if (!roomLogs[roomId]) {
        roomLogs[roomId] = [];
        roomCommitIndices[roomId] = 0;
    }

    // If the room has more than 10,000 strokes, silently delete the oldest one
    if (roomLogs[roomId].length > 10000) {
        roomLogs[roomId].shift(); // Removes the very first item in the array
    }

    roomLogs[roomId].push(newStroke);
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
            const response = await axios.post(`${followerUrl}/append-entries`, payload);
            
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
                        roomId: roomId, // NEW: Include the room ID here too
                        prevLogIndex: response.data.followerLogLength - 1,
                        entries: missingStrokes,
                        leaderCommitIndex: roomCommitIndices[roomId]
                    });
                    
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
        try {
            await axios.post('http://gateway:3000/broadcast', newStroke);
        } catch (e) {}

        res.json({ success: true, message: "Stroke committed to cluster" });
    } else {
        console.log(`[Replica ${REPLICA_ID}] MAJORITY FAILED. Stroke discarded.`);
        roomLogs[roomId].pop(); // Remove it from our log because the cluster rejected it
        res.status(500).json({ success: false, message: "Cluster failed to reach consensus" });
    }
});

// --- ENDPOINT 2: Followers receive data from Leader ---
app.post('/append-entries', (req, res) => {
    const { term, roomId, prevLogIndex, entries, leaderCommitIndex } = req.body;

    // Reject if the leader's term is outdated
    if (term < currentTerm) {
        return res.json({ success: false });
    }

    // If this room doesn't exist in our memory yet, create it!
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

    // Safely append the strokes
    if (entries && entries.length > 0) {
        roomLogs[roomId].push(...entries);
        console.log(`[Replica ${REPLICA_ID}] Follower saved stroke! Log size: ${roomLogs[roomId].length}`);
    }

    // Keep the commit index synced with the Leader
    if (leaderCommitIndex > roomCommitIndices[roomId]) {
        roomCommitIndices[roomId] = Math.min(leaderCommitIndex, roomLogs[roomId].length - 1);
    }

    res.json({ success: true });
});

// --- UPGRADE: Delete the room from memory to save RAM ---
app.delete('/room/:roomId', (req, res) => {
    const roomId = req.params.roomId;
    delete roomLogs[roomId];
    delete roomCommitIndices[roomId];
    console.log(`[Replica ${REPLICA_ID}] Room ${roomId} deleted from memory.`);
    res.json({ success: true });
});

// --- ENDPOINT 3: For Member 1's "Latecomer" Bug ---
// Sends the entire canvas history when someone new joins
// UPGRADE: Now it requires the room ID!
app.get('/canvas/:roomId', (req, res) => {
    const roomId = req.params.roomId;
    res.json({ log: roomLogs[roomId] || [] });
});

// Wipe Canvas History (Ghost Board Fix) ---
app.delete('/canvas/:roomId', (req, res) => {
    const roomId = req.params.roomId;
    if (roomLogs[roomId]) {
        roomLogs[roomId] = []; // Empty the array, but keep the room alive!
        console.log(`[Replica ${REPLICA_ID}] Cleared history for room ${roomId}`);
    }
    res.json({ success: true });
});

// The Undo Feature
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

    // 2. Filter out ALL segments that belong to that batch!
    roomLogs[roomId] = roomLogs[roomId].filter(stroke => stroke.strokeId !== targetStrokeId);
    
    console.log(`[Replica ${REPLICA_ID}] Undid full stroke batch for ${userName}`);
    res.json({ success: true });
});

// --- ROLE 4: STATUS API ---
app.get('/status', (req, res) => {
    // Upgraded to show the number of active rooms instead of array length
    res.json({ state, currentTerm, activeRooms: Object.keys(roomLogs).length });
});

app.listen(PORT, () => {
    console.log(`Replica ${REPLICA_ID} running on port ${PORT} as ${state}`);
});