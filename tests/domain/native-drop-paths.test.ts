import { describe, expect, it } from "vitest";
import { nativeDropPaths } from "$lib/domain/native-drop-paths";
describe("native file drop admission",()=>{
  it("preserves absolute POSIX file names and flattened GTK file lists",()=>{
    expect(nativeDropPaths(["/images/one.pngfile:///images/two.png","/images/back\\slash.png"],false)).toEqual(["/images/one.png","/images/two.png","/images/back\\slash.png"]);
  });
  it("admits Windows drive, UNC and extended paths",()=>{
    const paths=["C:\\images\\one.png","//server/share/images/one.png","\\\\?\\C:\\images\\one.png","\\\\?\\UNC\\server\\share\\images\\one.png"];
    expect(nativeDropPaths(paths,true)).toEqual(paths);
  });
  it("ignores blob URLs, web URLs, relative paths, NUL and traversal",()=>{
    for(const windows of [false,true]) expect(nativeDropPaths(["blob:tauri://localhost/uuid","https://example.com/img.png","image.png","/images/../image.png","/images/\u0000image.png","C:relative.png","/"],windows)).toEqual([]);
    expect(nativeDropPaths(["/images/one.png","blob:tauri://localhost/uuid"],false)).toEqual(["/images/one.png"]);
  });
});
