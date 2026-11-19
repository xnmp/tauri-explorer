// Omarchy theme data for the "shoutout" demo. Colours are the theme repos' colors.toml values;
// color0..15 follow Omarchy's own alacritty/ghostty templates
// (0=background 1=red 2=green 3=yellow 4=blue 5=magenta 6=cyan 7=foreground 8=muted 9..14=bright_* 15=bright_foreground).
window.TX_OMARCHY = {
  sakura: {
    name: "Sakura",
    credit: "Omarchy theme by bjarneo",
    url: "https://github.com/bjarneo/omarchy-sakura-theme",
    licence: "No licence file in repo (GitHub reports none); not stated",
    dark: true,
    v: ["#0d0509", "#230e18", "#f0eaed", "#c6afba", "#d9a56c", "#f29b9a"],
    palette: {
      background: "#0d0509", foreground: "#f0eaed", cursor: "#ffffff", selection: "#230e18",
      color0: "#0d0509", color1: "#e85f6f", color2: "#f29b9a", color3: "#d4a882",
      color4: "#d9a56c", color5: "#d1b399", color6: "#e8c099", color7: "#f0eaed",
      color8: "#7a5c66", color9: "#ff7a8a", color10: "#ffb5b4", color11: "#e6ba94",
      color12: "#ebb97e", color13: "#e3c5ab", color14: "#fbd2ab", color15: "#ffffff",
      accent: "#d9a56c"
    },
    // The theme repo's own backgrounds carry no licence, so this page wears original pictures made for it in the
    // theme's colours (originals and prompts in output/imagegen/wallpaper-pass/). `own` marks a picture as the page's,
    // so the desktop caption credits the theme's colours to its maker without claiming the picture is theirs.
    wallpapers: [
      { src: "assets-desktop/sakura.webp", avg: "#3e1b21", own: true, title: "Lantern-lit canal under the blossom", origin: "made for this page (output/imagegen/wallpaper-pass/sakura.png)" },
      { src: "assets-desktop/sakura-2.webp", avg: "#decab4", own: true, title: "Petals drifting on the pond", origin: "made for this page (output/imagegen/wallpaper-pass/sakura-2.png)" },
      { src: "assets-desktop/sakura-3.webp", avg: "#caa086", own: true, title: "Stone steps through the blossom", origin: "made for this page (output/imagegen/wallpaper-pass/sakura-3.png)" }
    ]
  },
  kanagawa: {
    name: "Kanagawa",
    credit: "Omarchy theme (basecamp/omarchy); palette from kanagawa.nvim by rebelot",
    url: "https://github.com/omacom/omarchy/tree/quattro/themes/kanagawa",
    licence: "MIT (basecamp/omarchy LICENSE, repo-wide)",
    dark: true,
    v: ["#1f1f28", "#17171e", "#dcd7ba", "#c8c093", "#7e9cd8", "#c0a36e"],
    palette: {
      background: "#1f1f28", foreground: "#dcd7ba", cursor: "#dcd7ba", selection: "#363646",
      color0: "#1f1f28", color1: "#c34043", color2: "#76946a", color3: "#c0a36e",
      color4: "#7e9cd8", color5: "#957fb8", color6: "#6a9589", color7: "#dcd7ba",
      color8: "#54546d", color9: "#e82424", color10: "#98bb6c", color11: "#e6c384",
      color12: "#7fb4ca", color13: "#938aa9", color14: "#7aa89f", color15: "#dcd7ba",
      accent: "#dcd7ba"
    },
    wallpapers: [
      { src: "assets-desktop/omarchy-kanagawa.webp", avg: "#a0a09c", origin: "backgrounds/1-kanagawa.jpg: Hokusai, The Great Wave off Kanagawa (c.1831, public-domain artwork); the digitised scan's source is not stated in the repo" }
    ]
  },
  "tokyo-night": {
    name: "Tokyo Night",
    credit: "Omarchy theme (basecamp/omarchy); palette from the Tokyo Night colour scheme by enkia",
    url: "https://github.com/omacom/omarchy/tree/quattro/themes/tokyo-night",
    licence: "MIT (basecamp/omarchy LICENSE, repo-wide)",
    dark: true,
    v: ["#1a1b26", "#24283b", "#c0caf5", "#a9b1d6", "#7aa2f7", "#e0af68"],
    palette: {
      background: "#1a1b26", foreground: "#a9b1d6", cursor: "#c0caf5", selection: "#292e42",
      color0: "#1a1b26", color1: "#f7768e", color2: "#9ece6a", color3: "#e0af68",
      color4: "#7aa2f7", color5: "#ad8ee6", color6: "#449dab", color7: "#a9b1d6",
      color8: "#414868", color9: "#ff7a93", color10: "#b9f27c", color11: "#ff9e64",
      color12: "#7da6ff", color13: "#bb9af7", color14: "#0db9d7", color15: "#c0caf5",
      accent: "#7aa2f7"
    },
    wallpapers: [
      { src: "assets-desktop/omarchy-tokyo-night.webp", avg: "#933f5f", origin: "backgrounds/0-liftoff.webp (AI-looking render of a rocket launching at sunset amid billowing smoke); authorship/licence not stated" },
      { src: "assets-desktop/omarchy-tokyo-night-2.webp", avg: "#943d54", origin: "backgrounds/2-quattro.webp (illustration of a rally Audi Quattro jumping at a purple sunset); authorship/licence not stated; depicts third-party branding" },
      { src: "assets-desktop/omarchy-tokyo-night-3.webp", avg: "#99467e", origin: "backgrounds/4-sunset-lake.webp (flat purple-pink illustration of a stag above a misty lake and mountains at sunset); authorship/licence not stated" }
    ]
  }
};
