# #756: Scaled marquee selection after virtual scrolling

A drag-session cache treated rows as stationary. It subtracted CSS scroll deltas from viewport-space rectangles without applying application zoom, and retained the old global indices when virtualization remounted rows. A real GTK/Wayland run at 125% compositor scale and 150% application zoom selected `virtual-039.txt` where the visible band intersected `virtual-048.txt`, `virtual-051.txt`, and `virtual-054.txt`.

Read current viewport rectangles when scroll/container geometry or rendered row identities/global indices change. Reuse them only while those inputs remain equal. Monitor device scale is already handled by the WebView; adding another devicePixelRatio multiplication would break the passing scale matrix.

Correct geometry alone is insufficient: with a stationary pointer, no mousemove triggers another hit test. VirtualList must publish its scroll update after Svelte settles the new rows. Forward that callback through every directory view to the shared marquee owner. A raw capture-phase scroll callback would race the virtualizer's existing animation-frame commit.

Details uses arithmetic row ranges. Its bottom boundary must be exclusive, matching strict rectangle intersection in List and Tiles. Reject zero-area bands in both paths.

Native acceptance needs real compositor scaling, not a browser DPR override. Headless Sway initially had no keyboard; compositor focus commands did not cause actual WebView focus/blur. Qualify the private virtual keyboard and document focus before claiming cancellation proof. Drivers also need private profiles/displays and verified listener ownership before session creation; a successful connection to a port alone can reach an unrelated driver.
