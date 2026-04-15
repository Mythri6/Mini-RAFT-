const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let currentLeader = null;
// The hardcoded addresses of your 3 RAFT containers
const clusterNodes = [
    'http://replica1:8081',
    'http://replica2:8082',
    'http://replica3:8083'
];

// We need a lock to prevent spamming the cluster with election checks
let isSearchingForLeader = false;
let leaderSearchPromise = null;

async function findLeader(force = false) {
    if (isSearchingForLeader && leaderSearchPromise) {
        return leaderSearchPromise;
    }

    leaderSearchPromise = (async () => {
        if (!force && currentLeader) {
            try {
                const check = await axios.get(`${currentLeader}/status`, { timeout: 500 });
                if (check.data && check.data.state === 'LEADER') {
                    return currentLeader;
                }
            } catch {
                // Fall through to full cluster scan.
            }
        }

        for (const node of clusterNodes) {
            try {
                const response = await axios.get(`${node}/status`, { timeout: 500 });
                if (response.data && response.data.state === 'LEADER') {
                    currentLeader = node;
                    return currentLeader;
                }
            } catch {
                // Node may be down.
            }
        }

        currentLeader = null;
        return null;
    })();

    isSearchingForLeader = true;
    try {
        return await leaderSearchPromise;
    } finally {
        isSearchingForLeader = false;
        leaderSearchPromise = null;
    }
}

async function requestViaLeader(requestFn) {
    let leader = currentLeader || await findLeader();
    if (!leader) {
        throw new Error('No active leader found');
    }

    try {
        return await requestFn(leader);
    } catch {
        leader = await findLeader(true);
        if (!leader) {
            throw new Error('No active leader found after retry');
        }
        return requestFn(leader);
    }
}

// A dedicated background loop to manage the UI state seamlessly
setInterval(async () => {
    const oldLeader = currentLeader;
    await findLeader();
    
    // If the cluster heals and finds a new leader, broadcast the green badge to all users!
    if (currentLeader && currentLeader !== oldLeader) {
        io.emit('leader-status', { status: 'healthy', msg: `Connected to Leader (${currentLeader})` });
    } else if (!currentLeader) {
        io.emit('leader-status', { status: 'chaotic', msg: 'LEADER DOWN! Re-electing...' });
    }
}, 2000);

void findLeader(true);

// --- RAFT WEBHOOK ---
// The Leader will call this endpoint ONLY after a stroke is successfully 
// committed to a majority of the replica logs.
/*app.post('/broadcast', (req, res) => {
    const committedStroke = req.body;
    
    // NOW the Gateway officially tells all connected browsers to draw it
    io.emit('remote-stroke', committedStroke);
    
    res.status(200).send("Broadcast successful");
});*/

// Keep track of which rooms actually exist
const activeRooms = new Set();

io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    const broadcastUserList = async (roomId) => {
        const sockets = await io.in(roomId).fetchSockets();
        const users = sockets.map(s => ({ id: s.id, name: s.userName }));
        io.to(roomId).emit('room-users-update', users);
    };

    // --- UPGRADE: Tweak 2 (Create vs Join Bouncer) ---
    socket.on('join-room', async (data, callback) => { // Notice the "callback" added here!
        const { roomId, userName, isCreating } = data;

        if (!isCreating && !activeRooms.has(roomId)) {
            // Reject! Room doesn't exist
            return callback({ success: false, message: "Room not found!" });
        }

        // If creating, add it to our official list
        if (isCreating) activeRooms.add(roomId);

        socket.join(roomId);
        socket.roomId = roomId;
        socket.userName = userName;
        
        try {
            const response = await requestViaLeader((leader) =>
                axios.get(`${leader}/canvas/${roomId}`, { timeout: 1000 })
            );
            socket.emit('canvas-history', response.data.log || []);
        } catch (error) {}

        await broadcastUserList(roomId);
        callback({ success: true }); // Let the frontend know they got in safely
    });

    // --- UPGRADE: Tweak 3 (Delete Room When Empty) ---
    socket.on('leave-room', async (data) => {
        socket.leave(data.roomId);
        socket.to(data.roomId).emit('cursor-disconnect', socket.id);
        socket.roomId = null;
        await broadcastUserList(data.roomId);
        checkAndCleanUpRoom(data.roomId);
    });

    socket.on('disconnect', async () => {
        if (socket.roomId) {
            socket.to(socket.roomId).emit('cursor-disconnect', socket.id);
            const tempRoom = socket.roomId;
            socket.leave(socket.roomId);
            await broadcastUserList(tempRoom);
            checkAndCleanUpRoom(tempRoom);
        }
    });

    // Helper to delete the room if the last person leaves
    async function checkAndCleanUpRoom(roomId) {
        const room = io.sockets.adapter.rooms.get(roomId);
        if (!room || room.size === 0) {
            console.log(`Room ${roomId} is empty. Deleting...`);
            activeRooms.delete(roomId);
            // Tell the RAFT cluster to wipe it from memory
            try {
                await requestViaLeader((leader) =>
                    axios.delete(`${leader}/room/${roomId}`, { timeout: 1000 })
                );
            } catch(e){}
        }
    }

    socket.on('cursor-move', (data) => { if (socket.roomId) socket.to(socket.roomId).emit('cursor-move', data); });
    // Removed the 'async' keyword here
    socket.on('draw-stroke', (strokeData) => {
        if (socket.roomId) socket.to(socket.roomId).emit('remote-stroke', strokeData); 
        
        // "Fire and Forget". Send it to the RAFT cluster in the 
        // background, but do NOT halt the WebSocket thread to wait for it.
        requestViaLeader((leader) =>
            axios.post(`${leader}/client-stroke`, strokeData, { timeout: 2000 })
        ).catch(() => {
            // Silently ignore drops. Our background health-checker will handle UI warnings.
        });
    });
    // Tell the Leader to forget the drawings
    socket.on('clear-canvas', async () => { 
        if (socket.roomId) {
            socket.to(socket.roomId).emit('clear-canvas'); 
            
            try { 
                // Hit your brand new Replica endpoint
                await requestViaLeader((leader) =>
                    axios.delete(`${leader}/canvas/${socket.roomId}`, { timeout: 1000 })
                );
            } catch(error) {}
        }
    });
    // --- UPGRADE: The Undo Feature ---
    socket.on('undo-stroke', async () => {
        if (!socket.roomId || !socket.userName) return;

        try {
            // Tell the Leader to delete the stroke from memory
            await requestViaLeader((leader) =>
                axios.delete(`${leader}/undo/${socket.roomId}/${socket.userName}`, { timeout: 1000 })
            );
            
            // Ask the Leader for the newly updated, fixed array
            const response = await requestViaLeader((leader) =>
                axios.get(`${leader}/canvas/${socket.roomId}`, { timeout: 1000 })
            );
            
            // Tell EVERYONE in the room to clear their board and redraw the fixed history!
            io.to(socket.roomId).emit('clear-canvas');
            io.to(socket.roomId).emit('canvas-history', response.data.log);
        } catch (error) {
            console.log("Undo failed.");
        }
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Gateway running on http://localhost:${PORT}`);
});