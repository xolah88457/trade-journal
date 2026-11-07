/**
 * Sumi Desktop Preferences Integration
 *
 * Runs early in the document <head> in the main world (before theme initialization)
 * to restore persisted `journal-*` preferences and hook Storage.prototype for automatic
 * synchronization with the desktop shell.
 */

export interface SumiDesktopBridge {
  preferences: Record<string, string>;
  savePreferences: (dict: Record<string, string>) => void;
  getInfo: () => Promise<{
    version: string;
    electronVersion: string;
    platform: string;
    arch: string;
    update?: unknown;
    [key: string]: unknown;
  }>;
  checkForUpdates: () => Promise<unknown>;
}

declare global {
  interface Window {
    sumiDesktop?: SumiDesktopBridge;
  }
}

/**
 * Main-world bootstrap script to restore journal preferences from window.sumiDesktop
 * and hook Storage.prototype to synchronize journal-* keys back to the desktop shell.
 *
 * Requirements:
 * - Runs in the main world BEFORE THEME_INIT_SCRIPT.
 * - Restores only keys starting with "journal-".
 * - Purges stale journal-* keys that do not exist in the bridge preferences.
 * - Hooks Storage.prototype setItem, removeItem, and clear.
 * - MUST NOT persist when writes occur on sessionStorage (only this === window.localStorage).
 * - Inert when window.sumiDesktop is not present.
 * - No dynamic JS/JSON injection.
 */
export const DESKTOP_PREFERENCES_BOOTSTRAP_SCRIPT = `(()=>{try{const b=window.sumiDesktop;if(!b||typeof b.savePreferences!=="function")return;const s=b.preferences;if(s&&typeof s==="object"&&!Array.isArray(s)){const t=[];for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k&&k.startsWith("journal-")&&!Object.prototype.hasOwnProperty.call(s,k))t.push(k)}for(const k of t)localStorage.removeItem(k);for(const[k,v]of Object.entries(s)){if(k.startsWith("journal-")&&typeof v==="string")localStorage.setItem(k,v)}}let p=false;const persist=()=>{if(p)return;p=true;try{const v={};for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k&&k.startsWith("journal-")){const val=localStorage.getItem(k);if(typeof val==="string")v[k]=val}}b.savePreferences(v)}catch{}finally{p=false}};const origSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){origSet.call(this,k,v);try{if(this===window.localStorage&&String(k).startsWith("journal-"))persist()}catch{}};const origRem=Storage.prototype.removeItem;Storage.prototype.removeItem=function(k){origRem.call(this,k);try{if(this===window.localStorage&&String(k).startsWith("journal-"))persist()}catch{}};const origClr=Storage.prototype.clear;Storage.prototype.clear=function(){origClr.call(this);try{if(this===window.localStorage)persist()}catch{}}}catch{}})();`;

export function isSumiDesktop(): boolean {
  return typeof window !== "undefined" && typeof window.sumiDesktop !== "undefined";
}

export function getSumiDesktop(): SumiDesktopBridge | null {
  if (typeof window !== "undefined" && window.sumiDesktop) {
    return window.sumiDesktop;
  }
  return null;
}
