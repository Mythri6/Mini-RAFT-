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

let currentLeader = 'http://replica1:8081';
// The hardcoded addresses of your 3 RAFT containers
const clusterNodes = [
    'http://replica1:8081',
    'http://replica2:8082',
    'http://replica3:8083'
];

// We need a lock to prevent spamming the cluster with election checks
let isSearchingForLeader = false;

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
            // Tell the leader we only want the history for THIS room
            const response = await axios.get(`${currentLeader}/canvas/${roomId}`);
            socket.emit('canvas-history', response.data.log);
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
            try { await axios.delete(`${currentLeader}/room/${roomId}`); } catch(e){}
        }
    }

    socket.on('cursor-move', (data) => { if (socket.roomId) socket.to(socket.roomId).emit('cursor-move', data); });
    socket.on('draw-stroke', async (strokeData) => {
        if (socket.roomId) socket.to(socket.roomId).emit('remote-stroke', strokeData); 
        try {
            await axios.post(`${currentLeader}/client-stroke`, strokeData);
            socket.emit('leader-status', { status: 'healthy', msg: `Connected to Leader (${currentLeader})` });
        } catch (error) {
            socket.emit('leader-status', { status: 'chaotic', msg: '⚠️ LEADER DOWN! Re-electing...' });
        }
    });
    // Tell the Leader to forget the drawings
    socket.on('clear-canvas', async () => { 
        if (socket.roomId) {
            socket.to(socket.roomId).emit('clear-canvas'); 
            
            try { 
                // Hit your brand new Replica endpoint
                await axios.delete(`${currentLeader}/canvas/${socket.roomId}`); 
            } catch(error) {}
        }
    });
    // --- UPGRADE: The Undo Feature ---
    socket.on('undo-stroke', async () => {
        if (!socket.roomId || !socket.userName) return;

        try {
            // Tell the Leader to delete the stroke from memory
            await axios.delete(`${currentLeader}/undo/${socket.roomId}/${socket.userName}`);
            
            // Ask the Leader for the newly updated, fixed array
            const response = await axios.get(`${currentLeader}/canvas/${socket.roomId}`);
            
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