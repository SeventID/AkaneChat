#!/usr/bin/env bun
import { BoxRenderable, TextRenderable, createCliRenderer } from "@opentui/core";

const renderer = await createCliRenderer({ exitOnCtrlC: true, targetFps: 30 });

const root = new BoxRenderable(renderer, {
  width: "100%",
  height: "100%",
  flexDirection: "column",
  backgroundColor: "#10131A",
  padding: 1,
  gap: 1,
});

const header = new BoxRenderable(renderer, {
  width: "100%",
  height: 3,
  border: true,
  borderColor: "#414B5D",
  paddingLeft: 1,
  justifyContent: "center",
});
header.add(new TextRenderable(renderer, {
  content: "AKANECHAT  ·  Open-source terminal AI client",
  fg: "#F2A6C7",
}));

const body = new BoxRenderable(renderer, {
  width: "100%",
  flexGrow: 1,
  flexDirection: "row",
  gap: 1,
});

const sidebar = new BoxRenderable(renderer, {
  width: 26,
  border: true,
  borderColor: "#414B5D",
  padding: 1,
  flexDirection: "column",
  gap: 1,
});
sidebar.add(new TextRenderable(renderer, { content: "CHATS", fg: "#F2A6C7" }));
sidebar.add(new TextRenderable(renderer, { content: "+  New conversation", fg: "#D8DEE9" }));
sidebar.add(new TextRenderable(renderer, { content: "\nNo conversations yet", fg: "#8792A5" }));

const conversation = new BoxRenderable(renderer, {
  flexGrow: 1,
  border: true,
  borderColor: "#414B5D",
  padding: 2,
  flexDirection: "column",
  gap: 1,
});
conversation.add(new TextRenderable(renderer, { content: "Welcome to AkaneChat", fg: "#F2A6C7" }));
conversation.add(new TextRenderable(renderer, {
  content: "Your terminal AI workspace is being prepared.\n\nProvider: not configured\nModel: not selected\n\nNext: connect an OpenAI-compatible endpoint to start chatting.",
  fg: "#D8DEE9",
}));
body.add(sidebar);
body.add(conversation);

const footer = new BoxRenderable(renderer, {
  width: "100%",
  height: 3,
  border: true,
  borderColor: "#414B5D",
  paddingLeft: 1,
  justifyContent: "center",
});
footer.add(new TextRenderable(renderer, {
  content: "q  Quit    Ctrl+C  Exit    ·    v0.1.0-dev",
  fg: "#8792A5",
}));

root.add(header);
root.add(body);
root.add(footer);
renderer.root.add(root);

renderer.keyInput.on("keypress", (key) => {
  if (key.name === "q" || (key.ctrl && key.name === "c")) renderer.destroy();
});
