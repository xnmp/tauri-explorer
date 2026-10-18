/** Original icon-family paint data, kept separate from selection policy. */
export interface ClassicLanguageIcon { readonly id: string; readonly color: string; }
export const CLASSIC_LANGUAGE_ICONS: Readonly<Record<string, ClassicLanguageIcon>> = {
    py: { id: "python", color: "#3776ab" },
    rs: { id: "rust", color: "#dea584" },
    go: { id: "go", color: "#00add8" },
    ts: { id: "typescript", color: "#3178c6" },
    tsx: { id: "typescript", color: "#3178c6" },
    js: { id: "javascript", color: "#f7df1e" },
    jsx: { id: "javascript", color: "#f7df1e" },
    java: { id: "java", color: "#ed8b00" },
    rb: { id: "ruby", color: "#cc342d" },
    cpp: { id: "cpp", color: "#659ad2" },
    c: { id: "c", color: "#a8b9cc" },
    cs: { id: "csharp", color: "#68217a" },
    swift: { id: "swift", color: "#f05138" },
    kt: { id: "kotlin", color: "#7f52ff" },
    php: { id: "php", color: "#777bb4" },
    html: { id: "html", color: "#e44d26" },
    htm: { id: "html", color: "#e44d26" },
    css: { id: "css", color: "#264de4" },
    json: { id: "json", color: "#f5a623" },
    md: { id: "markdown", color: "#083fa1" },
    sh: { id: "shell", color: "#4eaa25" },
    bash: { id: "shell", color: "#4eaa25" },
  };

/** Shared geometry for both compact and tile sizes. */
export const CLASSIC_BRAND_PATHS: Readonly<Record<string, string>> = {
  python: "M49.33 62h29.159C86.606 62 93 55.132 93 46.981V19.183c0-7.912-6.632-13.856-14.555-15.176-5.014-.835-10.195-1.215-15.187-1.191-4.99.023-9.612.448-13.805 1.191C37.098 6.188 35 10.758 35 19.183V30h29v4H23.776c-8.484 0-15.914 5.108-18.237 14.811-2.681 11.12-2.8 17.919 0 29.53C7.614 86.983 12.569 93 21.054 93H31V79.952C31 70.315 39.428 62 49.33 62zm-1.838-39.11c-3.026 0-5.478-2.479-5.478-5.545 0-3.079 2.451-5.581 5.478-5.581 3.015 0 5.479 2.502 5.479 5.581-.001 3.066-2.465 5.545-5.479 5.545zm74.789 25.921C120.183 40.363 116.178 34 107.682 34H97v12.981C97 57.031 88.206 65 78.489 65H49.33C41.342 65 35 72.326 35 80.326v27.8c0 7.91 6.745 12.564 14.462 14.834 9.242 2.717 17.994 3.208 29.051 0C85.862 120.831 93 116.549 93 108.126V97H64v-4h43.682c8.484 0 11.647-5.776 14.599-14.66 3.047-9.145 2.916-17.799 0-29.529zm-41.955 55.606c3.027 0 5.479 2.479 5.479 5.547 0 3.076-2.451 5.579-5.479 5.579-3.015 0-5.478-2.502-5.478-5.579 0-3.068 2.463-5.547 5.478-5.547z",
  css: "M8.76 1l10.055 112.883 45.118 12.58 45.244-12.626L119.24 1H8.76zm89.591 25.862l-3.347 37.605.01.203-.014.467v-.004l-2.378 26.294-.262 2.336L64 101.607v.001l-.022.019-28.311-7.888L33.75 72h13.883l.985 11.054 15.386 4.17-.004.008v-.002l15.443-4.229L81.075 65H48.792l-.277-3.043-.631-7.129L47.553 51h34.749l1.264-14H30.64l-.277-3.041-.63-7.131L29.401 23h69.281l-.331 3.862z",
};
