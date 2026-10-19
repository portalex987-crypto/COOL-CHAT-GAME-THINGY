
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 5e6
});

// Temporary in-memory storage.
// Data will be lost whenever this server restarts.
const users = new Map();
const groups = new Map();
const dmMessages = new Map();
const groupMessages = new Map();
const sockets = new Map();

const now = () => new Date().toISOString();
const makeId = () => crypto.randomBytes(8).toString("hex");
const validId = id => /^\d{6}$/.test(String(id || ""));
const cleanText = (value, max = 2000) =>
  typeof value === "string" ? value.slice(0, max) : "";

function user(id) {
  return users.get(String(id));
}

function sendError(socket, message) {
  socket.emit("error_msg", message);
}

function pairKey(a, b) {
  return [String(a), String(b)].sort().join("::");
}

function areFriends(a, b) {
  return !!user(a)?.friends.has(String(b)) &&
         !!user(b)?.friends.has(String(a));
}

function publicProfile(id) {
  const u = user(id);
  if (!u) return { displayName: "", pfp: null };
  return { displayName: u.displayName, pfp: u.pfp };
}

function emitProfile(id) {
  const u = user(id);
  if (!u) return;
  for (const friendId of u.friends) {
    const socket = sockets.get(friendId);
    if (socket) {
      socket.emit("profile_updated", {
        userId: String(id),
        profile: publicProfile(id),
        ...publicProfile(id)
      });
    }
  }
}

function emitUserData(id) {
  const u = user(id);
  const socket = sockets.get(String(id));
  if (!u || !socket) return;

  const friendProfiles = {};
  for (const fid of u.friends) {
    friendProfiles[fid] = publicProfile(fid);
  }

  const myGroups = [...groups.values()]
    .filter(g => g.members.has(String(id)))
    .map(g => ({
      id: g.id,
      name: g.name,
      owner: g.owner,
      members: [...g.members],
      createdAt: g.createdAt
    }));

  socket.emit("your_data", {
    friends: [...u.friends],
    pendingRequests: [...u.pendingRequests],
    groups: myGroups,
    friendProfiles
  });

  for (const fid of u.friends) {
    const messages = dmMessages.get(pairKey(id, fid)) || [];
    socket.emit("dm_history", { friendId: fid, messages });
  }

  for (const g of myGroups) {
    socket.emit("group_history", {
      groupId: g.id,
      messages: groupMessages.get(g.id) || []
    });
  }

  socket.emit(
    "online_friends",
    [...u.friends].filter(fid => sockets.has(fid))
  );
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "Study Games Chat backend",
    online: sockets.size
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, online: sockets.size });
});

io.on("connection", socket => {
  let myId = null;

  socket.on("register", rawId => {
    const id = String(rawId || "");

    if (!validId(id)) {
      sendError(socket, "Invalid user ID.");
      return;
    }

    // Avoid letting two active connections control the same ID.
    const existing = sockets.get(id);
    if (existing && existing.id !== socket.id) {
      existing.disconnect(true);
    }

    if (!users.has(id)) {
      users.set(id, {
        id,
        friends: new Set(),
        pendingRequests: new Set(),
        displayName: "",
        pfp: null
      });
    }

    myId = id;
    sockets.set(id, socket);
    emitUserData(id);

    const me = user(id);
    for (const fid of me.friends) {
      sockets.get(fid)?.emit("friend_online", id);
      sockets.get(fid)?.emit("profile_updated", {
        userId: id,
        profile: publicProfile(id),
        ...publicProfile(id)
      });
    }
  });

  socket.on("set_profile", data => {
    if (!myId || !user(myId)) return;

    const u = user(myId);
    u.displayName = cleanText(data?.displayName, 24);
    u.pfp = typeof data?.pfp === "string" &&
      data.pfp.length <= 4_000_000 ? data.pfp : null;

    emitProfile(myId);
    socket.emit("profile_updated", {
      userId: myId,
      profile: publicProfile(myId),
      ...publicProfile(myId)
    });
  });

  socket.on("add_friend", targetId => {
    if (!myId) return;

    const target = String(
      typeof targetId === "object"
        ? targetId?.userId ?? targetId?.id
        : targetId
    );

    if (!validId(target)) {
      sendError(socket, "Enter a valid 6-digit ID.");
      return;
    }
    if (target === myId) {
      sendError(socket, "You cannot add yourself.");
      return;
    }
    if (areFriends(myId, target)) {
      sendError(socket, "You are already friends.");
      return;
    }

    if (!users.has(target)) {
      // IDs are created by the client; only registered users can receive requests.
      sendError(socket, "That user has not connected yet.");
      return;
    }

    const recipient = user(target);
    if (recipient.pendingRequests.has(myId)) {
      sendError(socket, "A request is already pending.");
      return;
    }

    recipient.pendingRequests.add(myId);
    sockets.get(target)?.emit("friend_request", {
      fromId: myId,
      profile: publicProfile(myId),
      ...publicProfile(myId)
    });
    socket.emit("request_sent", target);
  });

  socket.on("friend_response", data => {
    if (!myId) return;

    const fromId = String(data?.fromId ?? data?.userId ?? data?.id ?? "");
    const accepted = data?.accepted ?? data?.accept ?? false;
    const me = user(myId);
    const requester = user(fromId);

    if (!me || !requester || !me.pendingRequests.has(fromId)) {
      sendError(socket, "That friend request is no longer available.");
      return;
    }

    me.pendingRequests.delete(fromId);

    if (accepted === true) {
      me.friends.add(fromId);
      requester.friends.add(myId);

      sockets.get(fromId)?.emit("friend_added", {
        userId: myId,
        profile: publicProfile(myId),
        ...publicProfile(myId)
      });
      socket.emit("friend_added", {
        userId: fromId,
        profile: publicProfile(fromId),
        ...publicProfile(fromId)
      });

      emitUserData(myId);
      emitUserData(fromId);
    }
  });

  socket.on("send_message", data => {
    if (!myId) return;

    const toId = String(data?.toId ?? data?.friendId ?? data?.userId ?? "");
    const text = cleanText(data?.text ?? data?.message);

    if (!areFriends(myId, toId) || !text.trim()) {
      sendError(socket, "Cannot send this message.");
      return;
    }

    const key = pairKey(myId, toId);
    const msg = {
      fromId: myId,
      text,
      type: "text",
      timestamp: now()
    };

    if (!dmMessages.has(key)) dmMessages.set(key, []);
    dmMessages.get(key).push(msg);
    if (dmMessages.get(key).length > 500) dmMessages.get(key).shift();

    sockets.get(toId)?.emit("receive_dm", {
      friendId: myId,
      message: msg,
      ...msg
    });
    socket.emit("receive_dm", {
      friendId: toId,
      message: msg,
      ...msg
    });
  });

  socket.on("typing_dm", data => {
    if (!myId) return;
    const toId = String(data?.toId ?? data?.friendId ?? data?.userId ?? "");
    if (areFriends(myId, toId)) {
      sockets.get(toId)?.emit("typing_dm", {
        fromId: myId,
        userId: myId
      });
    }
  });

  socket.on("send_image", data => {
    if (!myId) return;

    const toId = String(data?.toId ?? data?.friendId ?? data?.userId ?? "");
    const imageData = data?.imageData ?? data?.dataUrl;
    if (!areFriends(myId, toId) ||
        typeof imageData !== "string" ||
        imageData.length > 4_000_000) {
      sendError(socket, "Could not send image.");
      return;
    }

    const msg = {
      fromId: myId,
      type: "image",
      imageData,
      fileName: cleanText(data?.fileName, 150),
      timestamp: now()
    };
    const key = pairKey(myId, toId);
    if (!dmMessages.has(key)) dmMessages.set(key, []);
    dmMessages.get(key).push(msg);

    sockets.get(toId)?.emit("receive_dm", {
      friendId: myId,
      message: msg,
      ...msg
    });
    socket.emit("receive_dm", {
      friendId: toId,
      message: msg,
      ...msg
    });
  });

  socket.on("create_group", data => {
    if (!myId) return;

    const name = cleanText(
      typeof data === "string" ? data : data?.name,
      32
    ).trim();

    if (!name) {
      sendError(socket, "Enter a group name.");
      return;
    }

    const groupId = makeId();
    const members = new Set([myId]);
    const requestedMembers = data?.members ?? data?.friendIds ?? [];

    if (Array.isArray(requestedMembers)) {
      for (const raw of requestedMembers) {
        const fid = String(raw);
        if (areFriends(myId, fid)) members.add(fid);
      }
    }

    const group = {
      id: groupId,
      name,
      owner: myId,
      members,
      createdAt: now()
    };
    groups.set(groupId, group);
    groupMessages.set(groupId, []);

    for (const memberId of members) {
      sockets.get(memberId)?.emit("group_added", {
        id: groupId,
        group: {
          id: groupId,
          name,
          owner: myId,
          members: [...members],
          createdAt: group.createdAt
        },
        ...group
      });
      emitUserData(memberId);
    }
  });

  socket.on("send_group_message", data => {
    if (!myId) return;

    const groupId = String(data?.groupId ?? data?.id ?? "");
    const group = groups.get(groupId);
    const text = cleanText(data?.text ?? data?.message);

    if (!group?.members.has(myId) || !text.trim()) {
      sendError(socket, "Cannot send to this group.");
      return;
    }

    const msg = {
      fromId: myId,
      text,
      type: "text",
      timestamp: now()
    };
    const history = groupMessages.get(groupId) || [];
    history.push(msg);
    if (history.length > 500) history.shift();
    groupMessages.set(groupId, history);

    for (const memberId of group.members) {
      sockets.get(memberId)?.emit("receive_group_msg", {
        groupId,
        message: msg,
        ...msg
      });
    }
  });

  socket.on("send_group_image", data => {
    if (!myId) return;

    const groupId = String(data?.groupId ?? data?.id ?? "");
    const group = groups.get(groupId);
    const imageData = data?.imageData ?? data?.dataUrl;

    if (!group?.members.has(myId) ||
        typeof imageData !== "string" ||
        imageData.length > 4_000_000) {
      sendError(socket, "Could not send group image.");
      return;
    }

    const msg = {
      fromId: myId,
      type: "image",
      imageData,
      fileName: cleanText(data?.fileName, 150),
      timestamp: now()
    };
    const history = groupMessages.get(groupId) || [];
    history.push(msg);
    if (history.length > 500) history.shift();
    groupMessages.set(groupId, history);

    for (const memberId of group.members) {
      sockets.get(memberId)?.emit("receive_group_msg", {
        groupId,
        message: msg,
        ...msg
      });
    }
  });

  socket.on("typing_group", data => {
    if (!myId) return;
    const groupId = String(data?.groupId ?? data?.id ?? "");
    const group = groups.get(groupId);
    if (!group?.members.has(myId)) return;

    for (const memberId of group.members) {
      if (memberId !== myId) {
        sockets.get(memberId)?.emit("typing_group", {
          groupId,
          fromId: myId,
          userId: myId
        });
      }
    }
  });

  socket.on("add_to_group", data => {
    if (!myId) return;
    const group = groups.get(String(data?.groupId ?? ""));
    const target = String(data?.userId ?? "");

    if (!group || group.owner !== myId ||
        !areFriends(myId, target)) {
      sendError(socket, "You cannot add that member.");
      return;
    }

    group.members.add(target);
    for (const memberId of group.members) {
      sockets.get(memberId)?.emit("group_member_added", {
        groupId: group.id,
        userId: target,
        memberId: target,
        members: [...group.members]
      });
      emitUserData(memberId);
    }
  });

  socket.on("kick_from_group", data => {
    if (!myId) return;
    const group = groups.get(String(data?.groupId ?? ""));
    const target = String(data?.userId ?? "");

    if (!group || group.owner !== myId || target === group.owner) {
      sendError(socket, "You cannot remove that member.");
      return;
    }

    group.members.delete(target);
    sockets.get(target)?.emit("group_removed", group.id);
    for (const memberId of group.members) {
      sockets.get(memberId)?.emit("group_member_left", {
        groupId: group.id,
        userId: target,
        members: [...group.members]
      });
      emitUserData(memberId);
    }
  });

  socket.on("rename_group", data => {
    if (!myId) return;
    const group = groups.get(String(data?.groupId ?? ""));
    const name = cleanText(data?.name, 32).trim();

    if (!group || group.owner !== myId || !name) {
      sendError(socket, "You cannot rename this group.");
      return;
    }

    group.name = name;
    for (const memberId of group.members) {
      sockets.get(memberId)?.emit("group_renamed", {
        groupId: group.id,
        name,
        group: { id: group.id, name }
      });
      emitUserData(memberId);
    }
  });

  socket.on("leave_group", data => {
    if (!myId) return;
    const groupId = String(
      typeof data === "string" ? data : data?.groupId ?? ""
    );
    const group = groups.get(groupId);
    if (!group || !group.members.has(myId)) return;

    group.members.delete(myId);
    socket.emit("group_removed", groupId);

    if (group.members.size === 0) {
      groups.delete(groupId);
      groupMessages.delete(groupId);
      return;
    }

    for (const memberId of group.members) {
      sockets.get(memberId)?.emit("group_member_left", {
        groupId,
        userId: myId,
        members: [...group.members]
      });
      emitUserData(memberId);
    }
  });

  socket.on("remove_friend", data => {
    if (!myId) return;
    const target = String(
      typeof data === "string" ? data : data?.userId ?? data?.friendId ?? ""
    );

    user(myId)?.friends.delete(target);
    user(target)?.friends.delete(myId);

    sockets.get(target)?.emit("friend_removed", myId);
    socket.emit("friend_removed", target);
    emitUserData(myId);
    emitUserData(target);
  });

  socket.on("disconnect", () => {
    if (!myId || sockets.get(myId)?.id !== socket.id) return;

    sockets.delete(myId);
    const me = user(myId);
    if (me) {
      for (const fid of me.friends) {
        sockets.get(fid)?.emit("friend_offline", myId);
      }
    }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Study Games Chat server listening on ${PORT}`);
});
