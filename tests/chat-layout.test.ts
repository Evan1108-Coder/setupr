import React from "react";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import stringWidth from "string-width";
import { ChatLayout } from "../src/tui/layouts/ChatLayout.js";
import { createAppStore } from "../src/state/store.js";
import { saveChatSession } from "../src/state/chatSession.js";
import { cleanup, render, flushTui } from "./helpers/tui.js";
import packageInfo from "../package.json";
const terminal = vi.hoisted(() => ({ width: 140, height: 40 }));
vi.mock("../src/tui/hooks/useTerminalSize.js", () => ({ useTerminalSize: () => terminal }));
const directories: string[] = [];
afterEach(async () => { cleanup(); for (const p of directories.splice(0)) await rm(p, {recursive:true,force:true}); });
describe("real chat layout state", () => {
  it("recovers an interrupted session, loads env values and fits long transcripts after resize", async () => {
    const cwd=await mkdtemp(join(tmpdir(), "setupr-chat-layout-")); directories.push(cwd);
    await writeFile(join(cwd,"package.json"),JSON.stringify({name:"chat-fixture",scripts:{test:"node --test"}}));
    await writeFile(join(cwd,".env.example"),"PORT=3000\nAPI_KEY=\n");
    await writeFile(join(cwd,".env"),"PORT=4000\n");
    const old=createAppStore(cwd);
    for(let i=0;i<30;i++) old.getState().addMessage({role:"assistant",content:`**Response ${i}**\n\nA long message with normal words and useful context.\n\n- Check environment.\n- Check tests.`});
    old.getState().setRunning(true);
    await saveChatSession(cwd,old,{status:"thinking"});
    const store=createAppStore(cwd);
    const ui=render(React.createElement(ChatLayout,{cwd,store}));
    await vi.waitFor(async()=>{await flushTui();expect(store.getState().envVars).toHaveLength(2);}, { timeout: 10000 });
    expect(store.getState().isRunning).toBe(false);
    expect(store.getState().messages.at(-1)?.content).toContain("No request is running");
    expect(store.getState().envVars.find(v=>v.key==='PORT')?.value).toBe('4000');
    for(const [width,height] of [[140,40],[80,24],[60,18],[60,24],[200,60],[80,24]]) {
      terminal.width=width;terminal.height=height;
      ui.rerender(React.createElement(ChatLayout,{cwd,store}));await flushTui();
      const frame=ui.lastFrame()!;
      expect(frame.split("\n").length).toBeLessThanOrEqual(height);
      expect(frame.split("\n").every(line=>stringWidth(line)<=width)).toBe(true);
      if (height < 24) {
        expect(frame).toContain("RESIZE TERMINAL");
        expect(frame).not.toContain("SESSION");
      } else {
        expect(frame).toContain("SESSION");
        expect(frame).toContain("PLAN");
      }
      if (width === 140) expect(frame).toContain(`v${packageInfo.version}`);
      expect(frame).not.toContain("AI is working");
    }
  }, 15000);
});
