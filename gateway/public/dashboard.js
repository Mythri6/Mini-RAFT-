let isFetching = false;

async function updateDashboard() {
  if (isFetching) return; // 🔥 prevent overlapping calls
  isFetching = true;

  try {
    const res = await fetch('/cluster-status');
    const results = await res.json();

    // 🔢 Count active nodes
    const activeNodes = results.filter(r => r !== null).length;
    const hasQuorum = activeNodes >= 2;

    // 🎯 Render each replica
    results.forEach((data, i) => {
      const el = document.getElementById(`r${i + 1}`);

      // If replica is down
      if (!data) {
        el.className = "card down";
        el.innerHTML = `
          <h2>Replica ${i + 1}</h2>
          <p>DOWN</p>
        `;
        return;
      }

      // If replica is alive
      el.className = "card " + (data.state === "LEADER" ? "leader" : "follower");

      el.innerHTML = `
        <h2>Replica ${data.replicaId}</h2>
        <p><b>State:</b> ${data.state}</p>
        <p><b>Term:</b> ${data.currentTerm}</p>
        <p><b>Logs:</b> ${data.totalLogs}</p>
      `;
    });

    // 👑 Leader logic with quorum awareness
    let leader = null;
    if (hasQuorum) {
      leader = results.find(r => r && r.state === "LEADER");
    }

    // 🧠 Smart summary message
    const summaryEl = document.getElementById("summary");

    if (!hasQuorum) {
      summaryEl.innerHTML = `⚠️ Cluster unstable (no quorum)`;
    } else if (!leader) {
      summaryEl.innerHTML = `⏳ Electing leader...`;
    } else {
      summaryEl.innerHTML = `👑 Leader: Replica ${leader.replicaId} | Term: ${leader.currentTerm}`;
    }

  } catch (err) {
    console.error("Dashboard error:", err);
  }

  isFetching = false;
}

// 🔁 Balanced polling
setInterval(updateDashboard, 1500);

// 🚀 Initial load
updateDashboard();
