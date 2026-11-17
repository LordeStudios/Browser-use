/* AGENT LANES — three persistent agent slots behind one history window.
 *
 * The drawer runs ONE conversation at a time, but work must not be destroyed
 * to start more of it. Every run is tagged with a LANE (agent1/agent2/
 * agent3); the history window shows one tab per lane, so tasks, finished
 * history and subagent activity stay organised per agent instead of piling
 * into a single undifferentiated list.
 *
 * Everything here is pure: the renderer passes state in, gets rows out. That
 * keeps the grouping rules testable without an Electron window, which is the
 * only way to prove a rule like "a subagent row belongs to its parent's lane"
 * actually holds.
 */
(function (global) {
  var LANES = ['agent1', 'agent2', 'agent3'];
  // The slot names are CHAT numbers, not "agent" numbers: these tabs hold
  // conversations, and a tab that says "Agent 1" reads like a different thing
  // (a worker) from the chat you are actually in. One wording everywhere.
  var LANE_LABELS = { agent1: 'Chat 1', agent2: 'Chat 2', agent3: 'Chat 3' };

  // Statuses that mean "this row is doing something right now". The list
  // mirrors the agent's own live-run statuses plus the renderer's optimistic
  // "starting agent" placeholder, so a tab lights up the instant a send lands
  // instead of one state poll later.
  var ACTIVE_STATUSES = ['running', 'paused', 'awaiting_approval', 'awaiting_recovery', 'starting agent', 'queued', 'starting'];

  function normalizeLane(value) {
    var key = String(value == null ? '' : value).trim().toLowerCase();
    return LANES.indexOf(key) >= 0 ? key : null;
  }

  function laneLabel(lane) {
    return LANE_LABELS[normalizeLane(lane) || LANES[0]];
  }

  // A tab must say WHAT its agent is working on, not just which slot it is.
  // The agent names each conversation as the chat evolves (run.title), so the
  // tab follows that name and renames itself with every checkpoint. A lane
  // with no work yet keeps its slot name — the number is the fallback, never
  // the label once there is something real to show.
  //
  // 16 characters is MEASURED, not guessed: three tabs inside a 360px drawer
  // are 111px each, and a tab that also carries an activity marker has ~88px
  // of text room. At 10.5px/600 in the app's own font stack, a 16-character
  // label (ellipsis included) measures 77-87px, so it fits whole; a 17th
  // character starts clipping. Cutting here means the ellipsis lands on a word
  // boundary instead of CSS slicing a word in half.
  var TAB_WHOLE_MAX = 16;
  var TAB_STEM_MAX = 15;
  function shortName(title) {
    var text = String(title == null ? '' : title).replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (text.length <= TAB_WHOLE_MAX) return text;
    var cut = text.slice(0, TAB_STEM_MAX);
    // Only back up to a space when the cut actually landed INSIDE a word.
    // "Compare Pricing| Plans" is already a clean boundary and keeps its word.
    if (text.slice(TAB_STEM_MAX).charAt(0) !== ' ') {
      var space = cut.lastIndexOf(' ');
      if (space > 0) cut = cut.slice(0, space);
    }
    return cut.replace(/[\s,;:.\-–—]+$/, '') + '…';
  }

  // The row that names the lane: live work first (what this agent is doing
  // NOW), then the task the user has open, then the newest task. Subagents are
  // skipped — a fragment must never name the agent that spawned it.
  function laneNameRow(ordered) {
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < ordered.length; i += 1) {
      var row = ordered[i];
      if (row.kind !== 'task') continue;
      var score = row.active ? 2 : (row.open ? 1 : 0);
      if (score > bestScore) { best = row; bestScore = score; }
    }
    return best;
  }

  function isActiveStatus(status) {
    var key = String(status == null ? '' : status).trim().toLowerCase();
    return ACTIVE_STATUSES.indexOf(key) >= 0;
  }

  function isTerminalStatus(status) {
    var key = String(status == null ? '' : status).trim().toLowerCase();
    return ['completed', 'failed', 'cancelled', 'interrupted'].indexOf(key) >= 0;
  }

  // "20min", "1h", "10h", "2d", "1m" — the compact stamps agent UIs use.
  // Minutes are spelled out so "m" can mean a month, which is the convention
  // the user asked for and the only way "1m" is not ambiguous with "1min".
  function formatElapsed(ms) {
    var value = Number(ms);
    if (!Number.isFinite(value) || value < 0) return '';
    var seconds = Math.floor(value / 1000);
    if (seconds < 45) return 'now';
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + 'min';
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + 'h';
    var days = Math.round(hours / 24);
    if (days < 30) return days + 'd';
    var months = Math.round(days / 30);
    if (months < 12) return months + 'm';
    return Math.round(months / 12) + 'y';
  }

  function formatFinishedAgo(finishedAt, now) {
    var at = Number(finishedAt);
    if (!Number.isFinite(at) || at <= 0) return '';
    return formatElapsed((Number(now) || Date.now()) - at);
  }

  // The one-line status under a row title. A finished task shows WHEN it
  // finished — that is the only thing worth knowing about it — while a live
  // task shows what it is doing.
  function rowMeta(row, now) {
    if (!row) return '';
    if (row.active) {
      if (String(row.status || '').toLowerCase() === 'awaiting_approval') return 'waiting for approval';
      if (String(row.status || '').toLowerCase() === 'paused') return 'paused';
      var step = Number(row.step) || 0;
      return step > 0 ? 'running · step ' + step : 'running';
    }
    var ago = formatFinishedAgo(row.finishedAt, now);
    var status = String(row.status || '').toLowerCase();
    if (status === 'completed' || status === '') return ago || '';
    return ago ? status + ' · ' + ago : status;
  }

  function rowFromConversation(entry) {
    var alias = String(entry.subagentAlias || '').trim();
    var finishedAt = Number(entry.finishedAt) || Number(entry.updatedAt) || 0;
    return {
      id: String(entry.id || ''),
      kind: alias ? 'subagent' : 'task',
      lane: normalizeLane(entry.agentIdentity) || LANES[0],
      title: String(entry.title || entry.task || 'Untitled task').trim(),
      alias: alias,
      status: String(entry.status || ''),
      active: isActiveStatus(entry.status),
      step: 0,
      finishedAt: isTerminalStatus(entry.status) || !entry.status ? finishedAt : 0,
      at: finishedAt,
      parentId: alias ? String(entry.parentRunId || '') : '',
      source: 'history'
    };
  }

  function rowFromLiveSession(session, now) {
    return {
      id: String(session.id || ''),
      kind: 'task',
      lane: normalizeLane(session.agentIdentity) || LANES[0],
      title: String(session.title || 'Untitled task').trim(),
      alias: '',
      status: String(session.status || ''),
      active: isActiveStatus(session.status),
      step: Number(session.step) || 0,
      finishedAt: 0,
      at: now,
      parentId: '',
      source: 'live'
    };
  }

  function rowFromSubagent(entry, lane, now) {
    var finishedAt = Number(entry.finishedAt) || now;
    var status = String(entry.status || '');
    return {
      id: String(entry.runId || entry.alias || ''),
      kind: 'subagent',
      lane: lane,
      title: String(entry.task || 'Subagent task').trim(),
      alias: String(entry.alias || '').trim(),
      status: status,
      active: isActiveStatus(status),
      step: 0,
      finishedAt: isActiveStatus(status) ? 0 : finishedAt,
      at: finishedAt,
      parentId: String(entry.parentRunId || ''),
      source: 'live'
    };
  }

  function sortRows(rows) {
    return rows.slice().sort(function (left, right) {
      if (left.active !== right.active) return left.active ? -1 : 1;
      return (Number(right.at) || 0) - (Number(left.at) || 0);
    });
  }

  // Build the whole window model: one entry per lane, each with a flat,
  // render-ready row list where a subagent row directly follows its parent and
  // carries depth 1. A subagent whose parent is not in this list still shows
  // up (labelled with its name) rather than vanishing.
  function buildHistoryModel(input) {
    var options = input || {};
    var now = Number(options.now) || Date.now();
    var conversations = Array.isArray(options.conversations) ? options.conversations : [];
    var liveSessions = Array.isArray(options.liveSessions) ? options.liveSessions : [];
    var subagents = Array.isArray(options.subagents) ? options.subagents : [];

    var laneByRun = Object.create(null);
    var liveRows = [];
    var seen = Object.create(null);
    for (var s = 0; s < liveSessions.length; s += 1) {
      var session = liveSessions[s];
      if (!session || !session.id) continue;
      var liveRow = rowFromLiveSession(session, now);
      laneByRun[liveRow.id] = liveRow.lane;
      seen[liveRow.id] = true;
      liveRows.push(liveRow);
    }

    var historyRows = [];
    // Live subagents come BEFORE saved records: the roster is the fresher
    // truth, and a subagent whose run is still going must read as active even
    // though its last checkpoint says "completed".
    var subagentRows = [];
    for (var a = 0; a < subagents.length; a += 1) {
      var record = subagents[a];
      if (!record || !String(record.alias || '').trim()) continue;
      var runId = String(record.runId || '');
      if (runId && seen[runId]) continue;
      var parentId = String(record.parentRunId || '');
      var lane = normalizeLane(record.lane) || normalizeLane(laneByRun[parentId]) || LANES[0];
      var subRow = rowFromSubagent(record, lane, now);
      if (runId) seen[runId] = true;
      subagentRows.push(subRow);
    }
    for (var c = 0; c < conversations.length; c += 1) {
      var entry = conversations[c];
      if (!entry || !entry.id) continue;
      // A live session or live subagent is the same run as its checkpointed
      // record. The live row is fresher, so it wins; otherwise the task would
      // appear twice.
      if (seen[String(entry.id)]) continue;
      var row = rowFromConversation(entry);
      seen[row.id] = true;
      if (row.parentId && laneByRun[row.parentId]) row.lane = laneByRun[row.parentId];
      historyRows.push(row);
    }

    var all = liveRows.concat(historyRows, subagentRows);
    // OPEN vs ACTIVE are different questions and the list must answer both.
    // "active" means work is happening; "open" means THIS is the task currently
    // loaded in the transcript. Without the second flag a user scrolling history
    // cannot tell which row they are already looking at, and reopening the
    // screen drops them on a tab that may not even contain it.
    var openId = String(options.openId || '');
    // A subagent has its own drawer tab, so "the task you are looking at" can
    // be a subagent rather than the conversation that spawned it. When an alias
    // is supplied it wins: only ONE row is ever open, and it is the one on
    // screen.
    var openAlias = String(options.openAlias || '').trim();
    var openLane = null;
    for (var r = 0; r < all.length; r += 1) {
      var isOpen = openAlias
        ? (all[r].kind === 'subagent' && String(all[r].alias || '') === openAlias)
        : (Boolean(openId) && String(all[r].id) === openId);
      all[r].open = isOpen;
      if (isOpen) openLane = all[r].lane;
    }
    var lanes = LANES.map(function (lane) {
      var laneRows = all.filter(function (row) { return row.lane === lane; });
      var tasks = sortRows(laneRows.filter(function (row) { return row.kind === 'task'; }));
      var children = sortRows(laneRows.filter(function (row) { return row.kind !== 'task'; }));
      var ordered = [];
      var claimed = Object.create(null);
      for (var t = 0; t < tasks.length; t += 1) {
        ordered.push(tasks[t]);
        var kids = children.filter(function (child) { return child.parentId && child.parentId === tasks[t].id; });
        for (var k = 0; k < kids.length; k += 1) {
          kids[k].depth = 1;
          claimed[kids[k].id] = true;
          ordered.push(kids[k]);
        }
      }
      // Orphans (parent already pruned from history) still belong to the lane.
      for (var o = 0; o < children.length; o += 1) {
        if (claimed[children[o].id]) continue;
        children[o].depth = children[o].parentId ? 1 : 0;
        ordered.push(children[o]);
      }
      var hasActive = ordered.some(function (row) { return row.active; });
      // A lane can hold the open task without having any live work (a finished
      // task you reopened). The tab needs to say so, or browsing another tab
      // leaves no trail back to the task you were reading.
      var hasOpen = ordered.some(function (row) { return row.open; });
      var nameRow = laneNameRow(ordered);
      var name = nameRow ? String(nameRow.title || '').trim() : '';
      return {
        lane: lane,
        label: laneLabel(lane),
        // The AI's name for this lane's current task, and the shortened form
        // the tab prints. `name` stays whole so the tooltip can show it.
        name: name,
        tabLabel: shortName(name) || laneLabel(lane),
        rows: ordered,
        hasActive: hasActive,
        hasOpen: hasOpen,
        activeCount: ordered.filter(function (row) { return row.active; }).length
      };
    });

    return {
      now: now,
      openId: openId,
      // The lane that holds the open task, so the window can land on it
      // instead of showing a tab where nothing is marked.
      openLane: openLane,
      lanes: lanes,
      laneFor: function (lane) {
        var key = normalizeLane(lane) || LANES[0];
        for (var i = 0; i < lanes.length; i += 1) if (lanes[i].lane === key) return lanes[i];
        return lanes[0];
      }
    };
  }

  global.AgentLanes = {
    LANES: LANES,
    LANE_LABELS: LANE_LABELS,
    ACTIVE_STATUSES: ACTIVE_STATUSES,
    normalizeLane: normalizeLane,
    laneLabel: laneLabel,
    shortName: shortName,
    laneNameRow: laneNameRow,
    isActiveStatus: isActiveStatus,
    isTerminalStatus: isTerminalStatus,
    formatElapsed: formatElapsed,
    formatFinishedAgo: formatFinishedAgo,
    rowMeta: rowMeta,
    buildHistoryModel: buildHistoryModel
  };
})(typeof window !== 'undefined' ? window : globalThis);
