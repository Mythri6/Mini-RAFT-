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
app.post('/broadcast', (req, res) => {
    const committedStroke = req.body;
    
    // NOW the Gateway officially tells all connected browsers to draw it
    io.emit('remote-stroke', committedStroke);
    
    res.status(200).send("Broadcast successful");
});

io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    // Helper function to tell the room who is currently inside
    const broadcastUserList = async (roomId) => {
        const sockets = await io.in(roomId).fetchSockets();
        const users = sockets.map(s => ({ id: s.id, name: s.userName }));
        io.to(roomId).emit('room-users-update', users);
    };

    // 1. Join Room
    socket.on('join-room', async (data) => {
        socket.join(data.roomId);
        socket.roomId = data.roomId; // Attach it to the socket for easy access
        socket.userName = data.userName;
        console.log(`${data.userName} joined room: ${data.roomId}`);
        
        // Tell everyone the new player list!
        await broadcastUserList(data.roomId);
    });

    // 2. Leave Room
    socket.on('leave-room', async (data) => {
        socket.leave(data.roomId);
        socket.to(data.roomId).emit('cursor-disconnect', socket.id);
        socket.roomId = null;
        
        // Update the sidebar for the people left behind
        await broadcastUserList(data.roomId);
    });

    // 3. Disconnect completely
    socket.on('disconnect', async () => {
        console.log('Client disconnected:', socket.id);
        if (socket.roomId) {
            socket.to(socket.roomId).emit('cursor-disconnect', socket.id);
            const tempRoom = socket.roomId;
            socket.leave(socket.roomId);
            await broadcastUserList(tempRoom);
        }
    });

    // 4. Only broadcast cursors to people in the SAME room
    socket.on('cursor-move', (data) => {
        if (socket.roomId) {
            socket.to(socket.roomId).emit('cursor-move', data);
        }
    });

    // 5. Broadcast strokes to people in the SAME room & handle RAFT failover
    socket.on('draw-stroke', async (strokeData) => {
        if (socket.roomId) {
            socket.to(socket.roomId).emit('remote-stroke', strokeData); 
        }

        try {
            await axios.post(`${currentLeader}/client-stroke`, strokeData);
            socket.emit('leader-status', { status: 'healthy', msg: `Connected to Leader (${currentLeader})` });
        } catch (error) {
            socket.emit('leader-status', { status: 'chaotic', msg: '⚠️ LEADER DOWN! Re-electing...' });
            
            // Failover loop
            if (isSearchingForLeader) return;
            isSearchingForLeader = true;
            for (const node of clusterNodes) {
                try {
                    const response = await axios.get(`${node}/status`, { timeout: 1000 });
                    if (response.data && response.data.state === 'LEADER') {
                        currentLeader = node;
                        socket.emit('leader-status', { status: 'healthy', msg: `Recovered! New Leader: ${currentLeader}` });
                        break; 
                    }
                } catch (pingError) {}
            }
            isSearchingForLeader = false;
        }
    });

    // 6. Only clear the canvas for the SAME room
    socket.on('clear-canvas', () => {
        if (socket.roomId) {
            socket.to(socket.roomId).emit('clear-canvas');
        }
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Gateway running on http://localhost:${PORT}`);
});