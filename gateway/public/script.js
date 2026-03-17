const canvas = document.getElementById('drawingCanvas');
const ctx = canvas.getContext('2d');
const socket = io();

// --- LOBBY LOGIC ---
let myUserName = '';
let myRoomId = '';

const loginScreen = document.getElementById('loginScreen');
const boardContainer = document.getElementById('boardContainer');
const displayRoomId = document.getElementById('displayRoomId');
const nameInput = document.getElementById('usernameInput');

// Generate a random 5-letter code (e.g., "X7B9Q")
function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 5; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    return code;
}

function enterRoom(roomId) {
    const name = nameInput.value.trim();
    if (!name) return alert("Please enter your name first!");

    myUserName = name;
    myRoomId = roomId.toUpperCase();

    loginScreen.classList.add('hidden');
    boardContainer.classList.remove('hidden');
    displayRoomId.innerText = myRoomId;

    socket.emit('join-room', { roomId: myRoomId, userName: myUserName });
}

// Button: Create New Room
document.getElementById('createRoomBtn').addEventListener('click', () => {
    enterRoom(generateRoomCode());
});

// Button: Join Existing Room
document.getElementById('joinBtn').addEventListener('click', () => {
    const code = document.getElementById('roomInput').value;
    if (code.length < 5) return alert("Please enter a valid 5-character room code.");
    enterRoom(code);
});

// --- NEW: Render the User Sidebar with Bot Avatars! ---
// --- NEW: Render the User Sidebar with Mixed Avatars! ---
socket.on('room-users-update', (users) => {
    const sidebar = document.getElementById('userList');
    sidebar.innerHTML = ''; // Clear the old list
    
    // A list of all the coolest DiceBear collections
    const styles = ['pixel-art', 'bottts', 'adventurer', 'avataaars', 'dylan','micah', 'fun-emoji', 'miniavs'];
    users.forEach(user => {
        // Convert the username into a number so their random style stays consistent
        let charSum = 0;
        for (let i = 0; i < user.name.length; i++) {
            charSum += user.name.charCodeAt(i);
        }
        
        // Pick a style from the array based on their name's number
        const randomStyle = styles[charSum % styles.length];
        
        // Generate the unique SVG using their specific style and name
        const avatarUrl = `https://api.dicebear.com/9.x/${randomStyle}/svg?seed=${encodeURIComponent(user.name)}`;
        
        const userDiv = document.createElement('div');
        userDiv.className = 'user-card';
        
        // Add a "You" label if it's the current user
        const tag = user.id === socket.id ? ' (You)' : '';
        
        userDiv.innerHTML = `
            <img src="${avatarUrl}" alt="avatar">
            <span>${user.name}${tag}</span>
        `;
        sidebar.appendChild(userDiv);
    });
});

// Update the Leave Room Button to also clear the sidebar locally
document.getElementById('leaveRoomBtn').addEventListener('click', () => {
    socket.emit('leave-room', { roomId: myRoomId });
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    Object.values(remoteCursors).forEach(c => c.remove());
    for (const key in remoteCursors) delete remoteCursors[key];
    
    document.getElementById('userList').innerHTML = ''; // clear sidebar
    myRoomId = '';
    boardContainer.classList.add('hidden');
    loginScreen.classList.remove('hidden');
    document.getElementById('roomInput').value = ''; 
});

document.getElementById('copyRoomBtn').addEventListener('click', () => {
    if (!myRoomId) return;

    // A helper function to change the icon to a checkmark
    const showSuccess = () => {
        const icon = document.querySelector('#copyRoomBtn i');
        icon.className = 'fa-solid fa-check';
        setTimeout(() => icon.className = 'fa-regular fa-copy', 2000);
    };

    // Attempt 1: Modern API (Works on HTTPS or strict localhost)
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(myRoomId).then(showSuccess).catch(err => console.error("Clipboard API failed:", err));
    } else {
        // Attempt 2: The classic hidden textbox fallback (Works everywhere!)
        const textArea = document.createElement("textarea");
        textArea.value = myRoomId;
        
        // Hide it off-screen
        textArea.style.position = "absolute";
        textArea.style.left = "-999999px";
        
        document.body.appendChild(textArea);
        textArea.select();
        
        try {
            document.execCommand('copy');
            showSuccess();
        } catch (error) {
            console.error("Fallback copy failed:", error);
            alert("Copy failed! Your browser is blocking it.");
        }
        
        document.body.removeChild(textArea);
    }
});
// --- BULLETPROOF UUID GENERATOR ---
function generateUUID() {
    if (window.crypto && window.crypto.randomUUID) {
        return window.crypto.randomUUID();
    }
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}
// ... (Keep the rest of your canvas and drawing logic exactly the same!)
// --- CANVAS SETUP ---
canvas.width = 1000;
canvas.height = 600;

// State Variables
let isDrawing = false;
let lastX = 0, lastY = 0;
let currentTool = 'pen';
let currentColor = '#000000';
let currentWidth = 5;
let isSymmetryMode = false;
const remoteCursors = {}; 

// UI Elements
const penBtn = document.getElementById('penBtn');
const eraserBtn = document.getElementById('eraserBtn');
const symmetryBtn = document.getElementById('symmetryBtn');
const canvasFrame = document.getElementById('canvasFrame');

// Tool Switching
penBtn.addEventListener('click', () => {
    currentTool = 'pen';
    penBtn.classList.add('active');
    eraserBtn.classList.remove('active');
    canvas.className = 'cursor-pen';
});

eraserBtn.addEventListener('click', () => {
    currentTool = 'eraser';
    eraserBtn.classList.add('active');
    penBtn.classList.remove('active');
    canvas.className = 'cursor-eraser';
});

symmetryBtn.addEventListener('click', () => {
    isSymmetryMode = !isSymmetryMode;
    symmetryBtn.classList.toggle('active');
});

document.getElementById('clearBtn').addEventListener('click', () => {
    if (confirm("Clear the entire whiteboard?")) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        socket.emit('clear-canvas');
    }
});

// Stroke Weights & Colors
document.querySelectorAll('.weight-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.weight-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        currentWidth = e.target.getAttribute('data-weight');
    });
});

function setActiveColor(hexCode) {
    currentColor = hexCode;
    currentTool = 'pen';
    penBtn.classList.add('active');
    eraserBtn.classList.remove('active');
    canvas.className = 'cursor-pen';
}

document.querySelectorAll('.color-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        setActiveColor(e.target.getAttribute('data-color'));
    });
});

document.getElementById('customColorPicker').addEventListener('input', (e) => {
    document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
    setActiveColor(e.target.value);
});

// --- DRAWING ENGINE ---
function drawLine(startX, startY, endX, endY, color, thickness, tool) {
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.strokeStyle = (tool === 'eraser') ? '#FFFFFF' : color;
    ctx.lineWidth = thickness;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    if (tool === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = 'rgba(0,0,0,1)'; 
    } else {
        ctx.globalCompositeOperation = 'source-over';
    }
    
    ctx.stroke();
    ctx.closePath();
}

function emitStroke(startX, startY, endX, endY) {
    const strokeData = {
        strokeId: generateUUID(),
        roomId: myRoomId,
        userName: myUserName,
        startX: startX,
        startY: startY,
        endX: endX,
        endY: endY,
        color: currentColor,
        thickness: parseInt(currentWidth),
        tool: currentTool 
    };
    console.log("Sending JSON Payload:", strokeData);
    socket.emit('draw-stroke', strokeData);
}

canvas.addEventListener('mousedown', (e) => {
    isDrawing = true;
    lastX = e.offsetX;
    lastY = e.offsetY;
});

canvas.addEventListener('mousemove', (e) => {
    const currentX = e.offsetX;
    const currentY = e.offsetY;

    // Only send movements if we are actually in a room
    if (myRoomId) {
        socket.emit('cursor-move', { x: currentX, y: currentY, id: socket.id, name: myUserName });
    }

    if (!isDrawing) return;

    drawLine(lastX, lastY, currentX, currentY, currentColor, currentWidth, currentTool);
    emitStroke(lastX, lastY, currentX, currentY);

    if (isSymmetryMode) {
        const mirrorLastX = canvas.width - lastX;
        const mirrorCurrentX = canvas.width - currentX;
        drawLine(mirrorLastX, lastY, mirrorCurrentX, currentY, currentColor, currentWidth, currentTool);
        emitStroke(mirrorLastX, lastY, mirrorCurrentX, currentY); 
    }

    lastX = currentX;
    lastY = currentY;
});

canvas.addEventListener('mouseup', () => isDrawing = false);
canvas.addEventListener('mouseout', () => isDrawing = false);

// --- SERVER EVENTS ---
socket.on('remote-stroke', (data) => {
    drawLine(data.startX, data.startY, data.endX, data.endY, data.color, data.thickness, data.tool);
});

socket.on('clear-canvas', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
});

socket.on('leader-status', (data) => {
    const badge = document.getElementById('clusterStatus');
    badge.className = `status-badge ${data.status}`;
    document.getElementById('statusText').innerText = data.msg;
});

// Multiplayer Live Cursors
socket.on('cursor-move', (data) => {
    if (!remoteCursors[data.id]) {
        const cursorEl = document.createElement('div');
        cursorEl.className = 'remote-cursor';
        cursorEl.innerHTML = `<i class="fa-solid fa-arrow-pointer"></i><span>${data.name}</span>`;
        canvasFrame.appendChild(cursorEl);
        remoteCursors[data.id] = cursorEl;
    }
    
    remoteCursors[data.id].style.left = `${data.x + 15}px`;
    remoteCursors[data.id].style.top = `${data.y + 15}px`;
});

socket.on('cursor-disconnect', (id) => {
    if (remoteCursors[id]) {
        remoteCursors[id].remove();
        delete remoteCursors[id];
    }
});