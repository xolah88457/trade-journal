export type Theme = "dark" | "light";
export const THEME_KEY = "journal-theme-v1";
export const themePreference = (value: string | null): Theme =>
  value === "dark" ? "dark" : "light";

// Apply saved preferences before paint; new journals start on Kami's parchment.
export const THEME_INIT_SCRIPT = `(()=>{let theme="light";try{theme=localStorage.getItem(${JSON.stringify(THEME_KEY)})==="dark"?"dark":"light"}catch{}document.documentElement.classList.toggle("dark",theme==="dark")})();`;
