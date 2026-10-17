import type { FileIconIdentity } from '$lib/domain/file-icon-identity';

/** User-facing examples shared by resolution tests and the rendered full-catalog proof. */
export const FILE_ICON_EXAMPLES: readonly (readonly [string, FileIconIdentity])[] = [
  ['source.ts','typescript'],['source.js','javascript'],['App.tsx','react-ts'],['App.jsx','react-js'],
  ['script.py','python'],['lib.rs','rust'],['main.go','go'],['Main.java','java'],['app.rb','ruby'],
  ['main.c','c'],['main.cpp','cpp'],['Main.cs','csharp'],['App.swift','swift'],['Main.kt','kotlin'],['index.php','php'],['init.lua','lua'],
  ['index.html','html'],['style.css','css'],['style.scss','sass'],['package.json','json'],['config.yaml','yaml'],['README.md','markdown'],
  ['App.svelte','svelte'],['App.vue','vue'],['setup.sh','shell'],['settings.toml','config'],['.gitignore','git'],['Dockerfile','docker'],
  ['image.svg','image'],['files.zip','archive'],['song.mp3','audio'],['movie.mp4','video'],['report.pdf','pdf'],['letter.docx','word'],
  ['budget.xlsx','spreadsheet'],['slides.pptx','presentation'],['data.sqlite','database'],['font.woff2','font'],['app.exe','executable'],
  ['shortcut.lnk','shortcut'],['notes.txt','text'],['script.ahk','code'],['unknown.xyz','file'],
];
