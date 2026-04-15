const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'data.json');

function loadData() {
    try {
        const data = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(data);
    } catch {
        return { currentTerm: 0, log: {} };
    }
}

function saveData(data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function saveState(currentTerm, roomLogs) {
    const data = {
        currentTerm,
        log: roomLogs
    };
    saveData(data);
}

module.exports = {
    loadData,
    saveState
};
