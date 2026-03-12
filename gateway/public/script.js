const canvas = document.getElementById('drawingCanvas');
const ctx = canvas.getContext('2d');
const socket = io();

canvas.width = 1000;
canvas.height = 600;

// State Variables
let isDrawing = false;
let lastX = 0, lastY = 0;
let currentTool = 'pen';
let currentColor = '#000000';
let currentWidth = 5;
let isSymmetryMode = false;
const remoteCursors = {}; // Store teammate cursors

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

// Drawing Engine
// Drawing Engine
function drawLine(x0, y0, x1, y1, color, thickness, tool) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    
    if (tool === 'eraser') {
        // This literally deletes pixels, making them transparent again
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = 'rgba(0,0,0,1)'; // Color doesn't matter here
    } else {
        // Standard drawing mode
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = color;
    }
    
    ctx.lineWidth = thickness;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.closePath();
}

function emitStroke(x0, y0, x1, y1) {
    socket.emit('draw-stroke', { x0, y0, x1, y1, color: currentColor, thickness: currentWidth, tool: currentTool });
}

canvas.addEventListener('mousedown', (e) => {
    isDrawing = true;
    lastX = e.offsetX;
    lastY = e.offsetY;
});

canvas.addEventListener('mousemove', (e) => {
    const currentX = e.offsetX;
    const currentY = e.offsetY;

    // Broadcast your cursor position to everyone else
    socket.emit('cursor-move', { x: currentX, y: currentY, id: socket.id });

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

// --- Server Events ---

socket.on('remote-stroke', (data) => {
    drawLine(data.x0, data.y0, data.x1, data.y1, data.color, data.thickness, data.tool);
});

socket.on('clear-canvas', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
});

// HUD Failover Status
socket.on('leader-status', (data) => {
    const badge = document.getElementById('clusterStatus');
    badge.className = `status-badge ${data.status}`;
    document.getElementById('statusText').innerText = data.msg;
});

// Multiplayer Live Cursors
socket.on('cursor-move', (data) => {
    if (!remoteCursors[data.id]) {
        // Create a new cursor element if it doesn't exist
        const cursorEl = document.createElement('div');
        cursorEl.className = 'remote-cursor';
        cursorEl.innerHTML = `<i class="fa-solid fa-arrow-pointer"></i><span>Teammate</span>`;
        canvasFrame.appendChild(cursorEl);
        remoteCursors[data.id] = cursorEl;
    }
    
    // Update position (adjusting slightly so pointer tip aligns with the mouse coordinate)
    remoteCursors[data.id].style.left = `${data.x + 15}px`;
    remoteCursors[data.id].style.top = `${data.y + 15}px`;
});

socket.on('cursor-disconnect', (id) => {
    if (remoteCursors[id]) {
        remoteCursors[id].remove();
        delete remoteCursors[id];
    }
});