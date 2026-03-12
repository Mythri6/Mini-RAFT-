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

    // Broadcast live cursor movements
    socket.on('cursor-move', (data) => {
        socket.broadcast.emit('cursor-move', data);
    });

    socket.on('draw-stroke', async (strokeData) => {
        // Broadcast immediately for UI smoothness
        socket.broadcast.emit('remote-stroke', strokeData); 

        try {
            // Attempt to send to RAFT leader
            await axios.post(`${currentLeader}/append-entries`, strokeData);
            socket.emit('leader-status', { status: 'healthy', msg: `Connected to Leader (${currentLeader})` });
            
        } catch (error) {
            // 1. Trigger the red Chaos HUD on the frontend
            socket.emit('leader-status', { status: 'chaotic', msg: '⚠️ LEADER DOWN! Re-electing...' });
            
            // 2. Prevent multiple strokes from triggering 50 searches at once
            if (isSearchingForLeader) return;
            isSearchingForLeader = true;
            
            console.log(`Leader ${currentLeader} failed. Searching for new leader...`);

            // 3. Ping the cluster to find the new leader
            for (const node of clusterNodes) {
                try {
                    // We assume Role 4 is building a GET /status endpoint
                    const response = await axios.get(`${node}/status`, { timeout: 1000 });
                    
                    if (response.data && response.data.state === 'LEADER') {
                        currentLeader = node; // REROUTE SUCCESSFUL!
                        console.log(`Found new leader: ${currentLeader}`);
                        
                        // Tell the UI the system recovered
                        socket.emit('leader-status', { status: 'healthy', msg: `Recovered! New Leader: ${currentLeader}` });
                        break; 
                    }
                } catch (pingError) {
                    // This node is either dead or not ready, skip it
                    console.log(`Node ${node} is unreachable or not leader.`);
                }
            }
            
            isSearchingForLeader = false;
        }
    });

    socket.on('clear-canvas', () => {
        socket.broadcast.emit('clear-canvas');
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected');
        // Tell clients to remove this person's cursor
        socket.broadcast.emit('cursor-disconnect', socket.id); 
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Gateway running on http://localhost:${PORT}`);
});