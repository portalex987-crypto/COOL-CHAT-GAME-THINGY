from pathlib import Path

server_js = r'''const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 10 * 1024 * 1024
});

app.use(express.json({ limit: "10mb" }));

// This server keeps data in memory. Render restarts will clear users,
// friendships, groups, and messages. Persistent storage can be added later.
const users = new Map();
const sockets = new Map();
const groups = new Map();
const dmMessages = new Map();
const groupMessages = new Map();
const MAX_MESSAGES = 500;

const now = () => new Date().toISOString();
const makeGroupId = () => crypto.randomBytes(8).toString("hex");
const validId = id => /^\d{6}$/.test(String(id ?? ""));
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
  return u
    ? { displayName: u.displayName || "", pfp: u.pfp || null }
    : { displayName: "", pfp: null };
}

function publicGroup(group) {
  return {
    id: group.id,
    name: group.name,
    owner: group.owner,
    members: [...group.members],
    createdAt: group.createdAt
  };
}

function groupForUser(groupId, userId) {
  const group = groups.get(String(groupId));
  return group && group.members.has(String(userId)) ? group : null;
}

function pushLimited(list, item) {
  list.push(item);
  if (list.length > MAX_MESSAGES) list.shift();
}

function emitProfile(userId) {
  const payload = {
    userId: String(userId),
    ...publicProfile(userId)
  };

  const u = user(userId);
  if (!u) return;

  for (const friendId of u.friends) {
    sockets.get(friendId)?.emit("profile_updated", payload);
  }
  sockets.get(String(userId))?.emit("profile_updated", payload);
}

function emitUserData(userId) {
  const id = String(userId);
  const u = user(id);
  if (!u) return;

  const friendProfiles = {};
  for (const friendId of u.friends) {
    friendProfiles[friendId] = publicProfile(friendId);
  }

  const myGroups = [...groups.values()]
    .filter(group => group.members.has(id))
    .map(publicGroup);

  sockets.get(id)?.emit("your_data", {
    friends: [...u.friends],
    pendingRequests: [...u.pendingRequests],
    groups: myGroups,
    friendProfiles
  });

  for (const friendId of u.friends) {
    sockets.get(id)?.emit("dm_history", {
      friendId,
      messages: dmMessages.get(pairKey(id, friendId)) || []
    });
  }

  for (const group of groups.values()) {
    if (group.members.has(id)) {
      sockets.get(id)?.emit("group_history", {
        groupId: group.id,
        messages: groupMessages.get(group.id) || []
      });
    }
  }

  sockets.get(id)?.emit("online_friends", [...u.friends].filter(fid => sockets.has(fid)));
}

function notifyFriendPresence(userId, online) {
  const u = user(userId);
  if (!u) return;
  for (const friendId of u.friends) {
    sockets.get(friendId)?.emit(online ? "friend_online" : "friend_offline", String(userId));
    sockets.get(friendId)?.emit("online_friends", [...(user(friendId)?.friends || [])].filter(fid => sockets.has(fid)));
  }
}

function removeUserFromGroup(group, userId) {
  group.members.delete(String(userId));
  if (group.owner === String(userId) && group.members.size) {
    group.owner = group.members.values().next().value;
  }
  if (group.members.size === 0) {
    groups.delete(group.id);
    groupMessages.delete(group.id);
  }
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "Study Games Chat backend",
    online: sockets.size
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, online: sockets.size, users: users.size });
});

io.on("connection", socket => {
  let myId = null;

  socket.on("register", rawId => {
    const id = String(rawId ?? "");
    if (!validId(id)) {
      sendError(socket, "Invalid user ID. Your ID must be 6 digits.");
      return;
    }

    // If this same account reconnects, disconnect its previous socket.
    const oldSocket = sockets.get(id);
    if (oldSocket && oldSocket.id !== socket.id) {
      oldSocket.emit("session_replaced");
      oldSocket.disconnect(true);
    }

    if (!users.has(id)) {
      users.set(id, {
        friends: new Set(),
        pendingRequests: new Set(),
        displayName: "",
        pfp: null
      });
    }

    myId = id;
    sockets.set(id, socket);
    socket.data.userId = id;

    emitUserData(id);
    notifyFriendPresence(id, true);
    emitProfile(id);
    console.log(`[connect] ${id}; online=${sockets.size}`);
  });

  socket.on("set_profile", data => {
    if (!myId || !user(myId)) return;
    const u = user(myId);
    if (data && typeof data === "object") {
      if (typeof data.displayName === "string") {
        u.displayName = data.displayName.trim().slice(0, 24);
      }
      if (data.pfp === null || typeof data.pfp === "string") {
        // Avoid accepting extremely large profile images.
        u.pfp = typeof data.pfp === "string" ? data.pfp.slice(0, 500000) : null;
      }
    }
    emitProfile(myId);
  });

  // Frontend sends add_friend as a raw six-digit string.
  socket.on("add_friend", targetValue => {
    if (!myId) return;

    const target = String(
      typeof targetValue === "object"
        ? targetValue?.userId ?? targetValue?.id ?? ""
        : targetValue ?? ""
    );

    if (!validId(target)) return sendError(socket, "ID must be 6 digits.");
    if (target === myId) return sendError(socket, "You cannot add yourself.");
    if (areFriends(myId, target)) return sendError(socket, "You are already friends.");
    if (!users.has(target)) {
      return sendError(socket, "That user has not connected yet. Ask them to open the chat first.");
    }

    const sender = user(myId);
    const recipient = user(target);

    if (recipient.pendingRequests.has(myId)) {
      return sendError(socket, "You already sent that friend request.");
    }
    if (sender.pendingRequests.has(target)) {
      // If both people requested each other, accept the friendship directly.
      sender.pendingRequests.delete(target);
      recipient.pendingRequests.delete(myId);
      sender.friends.add(target);
      recipient.friends.add(myId);
      sockets.get(target)?.emit("friend_added", myId);
      socket.emit("friend_added", target);
      emitUserData(myId);
      emitUserData(target);
      return;
    }

    recipient.pendingRequests.add(myId);
    // Frontend expects the sender ID as a raw string.
    sockets.get(target)?.emit("friend_request", myId);
    socket.emit("request_sent", target);
  });

 socket.on("friend_response", data => {
  if (!myId) return;

  const requesterId = String(
    data?.requesterId ??
    data?.fromId ??
    data?.userId ??
    data?.id ??
    ""
  );

  const accepted = data?.accepted === true;
  const me = user(myId);
  const requester = user(requesterId);

  if (
    !validId(requesterId) ||
    !me ||
    !requester ||
    !me.pendingRequests.has(requesterId)
  ) {
    return sendError(
      socket,
      "That friend request is no longer available. Refresh both users and send a new request."
    );
  }

  me.pendingRequests.delete(requesterId);

  if (accepted) {
    me.friends.add(requesterId);
    requester.friends.add(myId);

    sockets.get(requesterId)?.emit("friend_added", myId);
    socket.emit("friend_added", requesterId);

    emitUserData(myId);
    emitUserData(requesterId);

    notifyFriendPresence(myId, true);
    notifyFriendPresence(requesterId, true);
  }

  console.log(
    `[friend_response] ${myId} ${accepted ? "accepted" : "declined"} request from ${requesterId}`
  );
});
      data?.requesterId ?? data?.fromId ?? data?.userId ?? data?.id ?? ""
    );
    const accepted = data?.accepted === true;
    const me = user(myId);
    const requester = user(requesterId);

    if (!validId(requesterId) || !me || !requester ||
        !me.pendingRequests.has(requesterId)) {
      return sendError(socket, "That friend request is no longer available.");
    }

    me.pendingRequests.delete(requesterId);

    if (accepted) {
      me.friends.add(requesterId);
      requester.friends.add(myId);

      // Frontend expects raw user IDs for friend_added.
      sockets.get(requesterId)?.emit("friend_added", myId);
      socket.emit("friend_added", requesterId);

      emitUserData(myId);
      emitUserData(requesterId);
      notifyFriendPresence(myId, true);
      notifyFriendPresence(requesterId, true);
    }
  });

  socket.on("send_message", data => {
    if (!myId) return;
    const toId = String(data?.toId ?? data?.friendId ?? data?.userId ?? "");
    const text = cleanText(data?.text ?? data?.message).trim();

    if (!validId(toId) || !areFriends(myId, toId) || !text) {
      return sendError(socket, "Cannot send this message. Make sure you are friends and the message is not empty.");
    }

    const message = {
      fromId: myId,
      toId,
      text,
      type: "text",
      timestamp: now()
    };

    const key = pairKey(myId, toId);
    if (!dmMessages.has(key)) dmMessages.set(key, []);
    pushLimited(dmMessages.get(key), message);

    // Frontend receive_dm expects fromId/toId at the top level.
    sockets.get(toId)?.emit("receive_dm", message);
    socket.emit("receive_dm", message);
  });

  socket.on("send_image", data => {
    if (!myId) return;
    const toId = String(data?.toId ?? data?.friendId ?? data?.userId ?? "");
    const imageData = typeof data?.imageData === "string" ? data.imageData : "";

    if (!validId(toId) || !areFriends(myId, toId) ||
        !imageData.startsWith("data:image/") ||
        imageData.length > 9 * 1024 * 1024) {
      return sendError(socket, "Cannot send this image. Check the friendship and image size.");
    }

    const message = {
      fromId: myId,
      toId,
      type: "image",
      imageData,
      fileName: cleanText(data?.fileName, 180),
      timestamp: now()
    };

    const key = pairKey(myId, toId);
    if (!dmMessages.has(key)) dmMessages.set(key, []);
    pushLimited(dmMessages.get(key), message);

    sockets.get(toId)?.emit("receive_dm", message);
    socket.emit("receive_dm", message);
  });

  socket.on("typing_dm", data => {
    if (!myId) return;
    const toId = String(data?.toId ?? data?.friendId ?? "");
    if (!areFriends(myId, toId)) return;
    sockets.get(toId)?.emit("typing_dm", {
      fromId: myId,
      isTyping: data?.isTyping === true
    });
  });

  socket.on("remove_friend", value => {
    if (!myId) return;
    const friendId = String(
      typeof value === "object" ? value?.userId ?? value?.id ?? "" : value ?? ""
    );
    if (!validId(friendId)) return;
    const me = user(myId);
    const friend = user(friendId);
    me?.friends.delete(friendId);
    friend?.friends.delete(myId);
    me?.pendingRequests.delete(friendId);
    friend?.pendingRequests.delete(myId);
    sockets.get(friendId)?.emit("friend_removed", myId);
    socket.emit("friend_removed", friendId);
    emitUserData(myId);
    if (friend) emitUserData(friendId);
  });

  socket.on("create_group", data => {
    if (!myId || !user(myId)) return;
    const name = cleanText(data?.name, 40).trim();
    if (!name) return sendError(socket, "Group name is required.");

    const requestedMembers = Array.isArray(data?.memberIds) ? data.memberIds : [];
    const members = new Set([myId]);
    for (const value of requestedMembers) {
      const id = String(value);
      if (validId(id) && id !== myId && areFriends(myId, id)) members.add(id);
    }

    const id = makeGroupId();
    const group = {
      id,
      name,
      owner: myId,
      members,
      createdAt: now()
    };
    groups.set(id, group);
    groupMessages.set(id, []);

    const payload = publicGroup(group);
    for (const memberId of members) {
      sockets.get(memberId)?.emit("group_added", payload);
      sockets.get(memberId)?.emit("group_history", { groupId: id, messages: [] });
    }
  });

  socket.on("send_group_message", data => {
    if (!myId) return;
    const groupId = String(data?.groupId ?? "");
    const group = groupForUser(groupId, myId);
    const text = cleanText(data?.text ?? data?.message).trim();
    if (!group || !text) return sendError(socket, "Cannot send a message to that group.");

    const message = {
      fromId: myId,
      groupId,
      text,
      type: "text",
      timestamp: now()
    };
    if (!groupMessages.has(groupId)) groupMessages.set(groupId, []);
    pushLimited(groupMessages.get(groupId), message);
    for (const memberId of group.members) {
      sockets.get(memberId)?.emit("receive_group_msg", message);
    }
  });

  socket.on("send_group_image", data => {
    if (!myId) return;
    const groupId = String(data?.groupId ?? "");
    const group = groupForUser(groupId, myId);
    const imageData = typeof data?.imageData === "string" ? data.imageData : "";
    if (!group || !imageData.startsWith("data:image/") ||
        imageData.length > 9 * 1024 * 1024) {
      return sendError(socket, "Cannot send that image to the group.");
    }

    const message = {
      fromId: myId,
      groupId,
      type: "image",
      imageData,
      fileName: cleanText(data?.fileName, 180),
      timestamp: now()
    };
    if (!groupMessages.has(groupId)) groupMessages.set(groupId, []);
    pushLimited(groupMessages.get(groupId), message);
    for (const memberId of group.members) {
      sockets.get(memberId)?.emit("receive_group_msg", message);
    }
  });

  socket.on("typing_group", data => {
    if (!myId) return;
    const groupId = String(data?.groupId ?? "");
    const group = groupForUser(groupId, myId);
    if (!group) return;
    const payload = {
      groupId,
      fromId: myId,
      isTyping: data?.isTyping === true
    };
    for (const memberId of group.members) {
      if (memberId !== myId) sockets.get(memberId)?.emit("typing_group", payload);
    }
  });

  socket.on("add_to_group", data => {
    if (!myId) return;
    const groupId = String(data?.groupId ?? "");
    const userId = String(data?.userId ?? "");
    const group = groups.get(groupId);

    if (!group || group.owner !== myId) {
      return sendError(socket, "Only the group owner can add members.");
    }
    if (!areFriends(myId, userId)) {
      return sendError(socket, "You can only add a friend to a group.");
    }
    if (group.members.has(userId)) return;
    group.members.add(userId);

    const payload = publicGroup(group);
    sockets.get(userId)?.emit("group_added", payload);
    sockets.get(userId)?.emit("group_history", {
      groupId,
      messages: groupMessages.get(groupId) || []
    });
    for (const memberId of group.members) {
      sockets.get(memberId)?.emit("group_member_added", { groupId, userId });
    }
    for (const memberId of group.members) {
      sockets.get(memberId)?.emit("group_added", publicGroup(group));
    }
  });

  socket.on("kick_from_group", data => {
    if (!myId) return;
    const groupId = String(data?.groupId ?? "");
    const userId = String(data?.userId ?? "");
    const group = groups.get(groupId);
    if (!group || group.owner !== myId || userId === myId || !group.members.has(userId)) {
      return sendError(socket, "You cannot kick that group member.");
    }

    group.members.delete(userId);
    sockets.get(userId)?.emit("group_removed", groupId);
    for (const memberId of group.members) {
      sockets.get(memberId)?.emit("group_member_left", {
        groupId,
        userId,
        newOwner: group.owner
      });
      sockets.get(memberId)?.emit("group_added", publicGroup(group));
    }
    if (group.members.size === 0) {
      groups.delete(groupId);
      groupMessages.delete(groupId);
    }
  });

  socket.on("leave_group", value => {
    if (!myId) return;
    const groupId = String(
      typeof value === "object" ? value?.groupId ?? value?.id ?? "" : value ?? ""
    );
    const group = groupForUser(groupId, myId);
    if (!group) return;

    removeUserFromGroup(group, myId);
    socket.emit("group_removed", groupId);

    const remaining = groups.get(groupId);
    if (remaining) {
      for (const memberId of remaining.members) {
        sockets.get(memberId)?.emit("group_member_left", {
          groupId,
          userId: myId,
          newOwner: remaining.owner
        });
        sockets.get(memberId)?.emit("group_added", publicGroup(remaining));
      }
    }
  });

  socket.on("rename_group", data => {
    if (!myId) return;
    const groupId = String(data?.groupId ?? "");
    const name = cleanText(data?.name, 40).trim();
    const group = groups.get(groupId);
    if (!group || group.owner !== myId) {
      return sendError(socket, "Only the group owner can rename the group.");
    }
    if (!name) return sendError(socket, "Group name cannot be empty.");

    group.name = name;
    for (const memberId of group.members) {
      sockets.get(memberId)?.emit("group_renamed", { groupId, name });
      sockets.get(memberId)?.emit("group_added", publicGroup(group));
    }
  });

  socket.on("disconnect", () => {
    if (!myId) return;
    if (sockets.get(myId)?.id === socket.id) {
      sockets.delete(myId);
      notifyFriendPresence(myId, false);
      console.log(`[disconnect] ${myId}; online=${sockets.size}`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Study Games Chat backend listening on port ${PORT}`);
});
'''

path = Path("/mnt/data/server.js")
path.write_text(server_js, encoding="utf-8")
print(f"Created {path} ({len(server_js.splitlines())} lines, {path.stat().st_size} bytes)")
