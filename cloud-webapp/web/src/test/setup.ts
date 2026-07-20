/**
 * Vitest setup — restore a working `localStorage` / `sessionStorage`.
 *
 * jsdom implements Web Storage, but on Node 22+ the runtime ships its own
 * experimental global `localStorage` (a non-enumerable getter gated behind
 * `--localstorage-file`). That getter is present on `globalThis` before the
 * jsdom environment populates it, wins over jsdom's own property, and returns
 * `undefined` when the flag is absent — so `localStorage.setItem`/`.clear`
 * throw "Cannot read properties of undefined". Force a plain in-memory Storage
 * onto both `globalThis` and `window` so the app code (and tests) get a real,
 * spec-shaped Storage regardless of the Node version.
 */

class MemoryStorage implements Storage {
  private m = new Map<string, string>();

  get length(): number {
    return this.m.size;
  }

  clear(): void {
    this.m.clear();
  }

  getItem(key: string): string | null {
    return this.m.has(key) ? (this.m.get(key) as string) : null;
  }

  key(index: number): string | null {
    return [...this.m.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.m.delete(key);
  }

  setItem(key: string, value: string): void {
    this.m.set(key, String(value));
  }
}

function install(name: 'localStorage' | 'sessionStorage'): void {
  const store = new MemoryStorage();
  const define = (target: object) => {
    Object.defineProperty(target, name, {
      value: store,
      configurable: true,
      writable: true,
      enumerable: true,
    });
  };
  define(globalThis);
  if (typeof window !== 'undefined' && window !== (globalThis as unknown)) {
    define(window);
  }
}

install('localStorage');
install('sessionStorage');
