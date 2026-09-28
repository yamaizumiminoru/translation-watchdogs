"use strict";

const BADGES = {
  disabled: { text: "", color: "#64748b" },
  armed: { text: "ON", color: "#15803d" },
  generating: { text: "…", color: "#2563eb" },
  interrupted: { text: "!", color: "#d97706" },
  stuck_timeout: { text: "!", color: "#d97706" },
  retrying: { text: "↻", color: "#d97706" },
  sent: { text: "👏", color: "#7c3aed" },
  rollover: { text: "↗", color: "#0f766e" },
  complete: { text: "✓", color: "#15803d" },
  error: { text: "!", color: "#dc2626" }
};

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== "SET_BADGE" || !sender.tab?.id) return;
  const badge = BADGES[message.status] || BADGES.error;
  chrome.action.setBadgeText({ tabId: sender.tab.id, text: badge.text });
  chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: badge.color });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url?.startsWith("https://chatgpt.com/")) {
    chrome.action.setBadgeText({ tabId, text: "" });
  }
});
