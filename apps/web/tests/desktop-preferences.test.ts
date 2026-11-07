import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import {
  DESKTOP_PREFERENCES_BOOTSTRAP_SCRIPT,
  isSumiDesktop,
  getSumiDesktop,
} from "../src/lib/desktop-preferences";
import { THEME_INIT_SCRIPT, THEME_KEY } from "../src/lib/theme";

describe("desktop preferences bootstrap integration", () => {
  function createMockStorage(StorageClass: any) {
    const store = new Map<string, string>();
    const storage = Object.create(StorageClass.prototype);
    storage._store = store;
    Object.defineProperty(storage, "length", {
      get() {
        return store.size;
      },
    });
    return storage;
  }

  function createStorageClass() {
    function StorageMock() {}
    StorageMock.prototype.getItem = function (this: any, key: string) {
      return this._store.get(key) ?? null;
    };
    StorageMock.prototype.setItem = function (this: any, key: string, value: string) {
      this._store.set(String(key), String(value));
    };
    StorageMock.prototype.removeItem = function (this: any, key: string) {
      this._store.delete(String(key));
    };
    StorageMock.prototype.clear = function (this: any) {
      this._store.clear();
    };
    StorageMock.prototype.key = function (this: any, index: number) {
      return Array.from(this._store.keys())[index] ?? null;
    };
    return StorageMock;
  }

  it("restores journal-* preferences and purges stale journal keys", () => {
    const StorageMock = createStorageClass();
    const localStore = createMockStorage(StorageMock);
    localStore.setItem("journal-theme-v1", "light");
    localStore.setItem("journal-old-stale", "to-be-removed");
    localStore.setItem("unrelated-key", "should-stay");

    let savedPrefs: Record<string, string> | null = null;
    const bridge = {
      preferences: {
        "journal-theme-v1": "dark",
        "journal-sidebar-width": "260",
      },
      savePreferences: (dict: Record<string, string>) => {
        savedPrefs = dict;
      },
    };

    const context = {
      window: {
        sumiDesktop: bridge,
        localStorage: localStore,
      },
      localStorage: localStore,
      Storage: StorageMock,
    };

    runInNewContext(DESKTOP_PREFERENCES_BOOTSTRAP_SCRIPT, context);

    // Verified: restored dark theme and sidebar width
    expect(localStore.getItem("journal-theme-v1")).toBe("dark");
    expect(localStore.getItem("journal-sidebar-width")).toBe("260");
    // Verified: stale journal key purged
    expect(localStore.getItem("journal-old-stale")).toBeNull();
    // Verified: non-journal key preserved
    expect(localStore.getItem("unrelated-key")).toBe("should-stay");
  });

  it("hooks Storage.prototype: persists when localStorage is modified", () => {
    const StorageMock = createStorageClass();
    const localStore = createMockStorage(StorageMock);
    let savedPrefs: Record<string, string> | null = null;

    const bridge = {
      preferences: {
        "journal-theme-v1": "light",
      },
      savePreferences: (dict: Record<string, string>) => {
        savedPrefs = dict;
      },
    };

    const context = {
      window: {
        sumiDesktop: bridge,
        localStorage: localStore,
      },
      localStorage: localStore,
      Storage: StorageMock,
    };

    runInNewContext(DESKTOP_PREFERENCES_BOOTSTRAP_SCRIPT, context);

    // Mutate localStorage journal key via hooked setItem
    context.localStorage.setItem("journal-theme-v1", "dark");
    expect(savedPrefs).toEqual({ "journal-theme-v1": "dark" });

    // Mutate unrelated key via hooked setItem -> does not trigger savePreferences
    savedPrefs = null;
    context.localStorage.setItem("non-journal-key", "value");
    expect(savedPrefs).toBeNull();

    // Remove journal key via hooked removeItem -> triggers savePreferences
    savedPrefs = null;
    context.localStorage.removeItem("journal-theme-v1");
    expect(savedPrefs).toEqual({});

    // Clear via hooked clear -> triggers savePreferences
    context.localStorage.setItem("journal-font", "serif");
    expect(savedPrefs).toEqual({ "journal-font": "serif" });
    savedPrefs = null;
    context.localStorage.clear();
    expect(savedPrefs).toEqual({});
  });

  it("CRITICAL: sessionStorage writes MUST NOT trigger persist or affect bridge", () => {
    const StorageMock = createStorageClass();
    const localStore = createMockStorage(StorageMock);
    const sessionStore = createMockStorage(StorageMock);
    let persistCount = 0;

    const bridge = {
      preferences: {},
      savePreferences: () => {
        persistCount++;
      },
    };

    const context = {
      window: {
        sumiDesktop: bridge,
        localStorage: localStore,
        sessionStorage: sessionStore,
      },
      localStorage: localStore,
      sessionStorage: sessionStore,
      Storage: StorageMock,
    };

    runInNewContext(DESKTOP_PREFERENCES_BOOTSTRAP_SCRIPT, context);

    // Call setItem on sessionStorage
    context.sessionStorage.setItem("journal-sensitive-temp", "secret");
    expect(persistCount).toBe(0);

    // Call removeItem on sessionStorage
    context.sessionStorage.removeItem("journal-sensitive-temp");
    expect(persistCount).toBe(0);

    // Call clear on sessionStorage
    context.sessionStorage.clear();
    expect(persistCount).toBe(0);
  });

  it("is completely inert when window.sumiDesktop is not present", () => {
    const StorageMock = createStorageClass();
    const localStore = createMockStorage(StorageMock);
    localStore.setItem("journal-theme-v1", "light");

    const context = {
      window: {
        localStorage: localStore,
      },
      localStorage: localStore,
      Storage: StorageMock,
    };

    // Should not throw and should not alter storage
    runInNewContext(DESKTOP_PREFERENCES_BOOTSTRAP_SCRIPT, context);
    expect(localStore.getItem("journal-theme-v1")).toBe("light");
    context.localStorage.setItem("journal-theme-v1", "dark");
    expect(localStore.getItem("journal-theme-v1")).toBe("dark");
  });

  it("restores theme preferences before THEME_INIT_SCRIPT runs", () => {
    const StorageMock = createStorageClass();
    const localStore = createMockStorage(StorageMock);
    const classes: string[] = [];

    const bridge = {
      preferences: {
        [THEME_KEY]: "dark",
      },
      savePreferences: () => {},
    };

    const context = {
      window: {
        sumiDesktop: bridge,
        localStorage: localStore,
      },
      localStorage: localStore,
      Storage: StorageMock,
      document: {
        documentElement: {
          classList: {
            toggle: (cls: string, enable: boolean) => {
              if (enable) classes.push(cls);
            },
          },
        },
      },
    };

    // Run bootstrap script first, then theme init script
    runInNewContext(DESKTOP_PREFERENCES_BOOTSTRAP_SCRIPT, context);
    runInNewContext(THEME_INIT_SCRIPT, context);

    // Theme init script should have picked up "dark" from restored localStorage
    expect(classes).toContain("dark");
  });

  it("helpers isSumiDesktop and getSumiDesktop work accurately", () => {
    expect(isSumiDesktop()).toBe(false);
    expect(getSumiDesktop()).toBeNull();
  });
});
