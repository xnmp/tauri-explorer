/**
 * Playwright script to test drag-and-drop functionality:
 * 1. Drag a folder from file list to Quick Access sidebar (pin/bookmark)
 * 2. Verify the folder appears as a bookmark
 * 3. Test drag-and-drop of files/folders into directories (move operation)
 */
import { chromium } from "playwright";

const TIMEOUT = 10000;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function screenshot(page, name) {
  const path = `/tmp/dnd-test-${name}.png`;
  await page.screenshot({ path });
  console.log(`  Screenshot saved: ${path}`);
  return path;
}

/**
 * Simulate a complete HTML5 drag-and-drop operation using dispatched events.
 * Playwright's built-in dragTo doesn't reliably set dataTransfer data for
 * custom MIME types, so we dispatch the events manually.
 */
async function simulateDragDrop(page, sourceSelector, targetSelector, dragData) {
  return await page.evaluate(
    ({ sourceSelector, targetSelector, dragData }) => {
      const source = document.querySelector(sourceSelector);
      const target = document.querySelector(targetSelector);

      if (!source) return { error: `Source not found: ${sourceSelector}` };
      if (!target) return { error: `Target not found: ${targetSelector}` };

      // Create a DataTransfer-like object
      const dataTransfer = new DataTransfer();
      for (const [type, value] of Object.entries(dragData)) {
        dataTransfer.setData(type, value);
      }

      // Dispatch dragstart on source
      const dragStartEvent = new DragEvent("dragstart", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      });
      source.dispatchEvent(dragStartEvent);

      // Dispatch dragover on target (must be prevented for drop to work)
      const dragOverEvent = new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      });
      target.dispatchEvent(dragOverEvent);

      // Dispatch drop on target
      const dropEvent = new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      });
      target.dispatchEvent(dropEvent);

      // Dispatch dragend on source
      const dragEndEvent = new DragEvent("dragend", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      });
      source.dispatchEvent(dragEndEvent);

      return { success: true };
    },
    { sourceSelector, targetSelector, dragData }
  );
}

async function main() {
  console.log("=== Drag-and-Drop Testing ===\n");

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  // Collect console messages for debugging
  const consoleMsgs = [];
  page.on("console", (msg) => {
    consoleMsgs.push(`[${msg.type()}] ${msg.text()}`);
  });

  try {
    // Navigate to the app
    console.log("1. Navigating to app...");
    await page.goto("http://localhost:1420", { waitUntil: "networkidle", timeout: TIMEOUT });
    await sleep(2000); // Let the app fully initialize

    await screenshot(page, "01-initial");

    // Check if file items loaded
    console.log("2. Waiting for file items to load...");
    const fileItemsLoaded = await page.waitForSelector(".file-item", { timeout: TIMEOUT }).catch(() => null);

    if (!fileItemsLoaded) {
      console.log("   No file items found. Checking app state...");
      await screenshot(page, "02-no-files");
      const bodyText = await page.textContent("body");
      console.log("   Body text (first 500 chars):", bodyText?.substring(0, 500));
      throw new Error("File items never loaded");
    }

    // Count items and list the first few
    const items = await page.$$eval(".file-item", (els) =>
      els.map((el) => ({
        name: el.querySelector(".name")?.textContent || "",
        isDir: el.classList.contains("directory"),
      }))
    );
    console.log(`   Found ${items.length} file items`);
    console.log(
      "   First 10:",
      items.slice(0, 10).map((i) => `${i.isDir ? "[DIR]" : "[FILE]"} ${i.name}`)
    );

    await screenshot(page, "02-files-loaded");

    // Find a directory to drag
    const directories = items.filter((i) => i.isDir);
    if (directories.length === 0) {
      throw new Error("No directories found to test drag-and-drop");
    }

    const targetDir = directories[0];
    console.log(`\n3. Testing drag-to-pin: Dragging "${targetDir.name}" to Quick Access...`);

    // Check the Quick Access section exists
    const quickAccessSection = await page.$(".quick-access");
    if (!quickAccessSection) {
      throw new Error("Quick Access section not found in sidebar");
    }

    // Check current bookmarks before drag
    const bookmarksBefore = await page.$$eval(".user-bookmark", (els) =>
      els.map((el) => el.querySelector("span")?.textContent || "")
    );
    console.log(`   Bookmarks before: [${bookmarksBefore.join(", ")}]`);

    // Get the directory's path info from the file item
    const dirInfo = await page.$$eval(
      ".file-item.directory",
      (els) => {
        const el = els[0];
        if (!el) return null;
        return {
          name: el.querySelector(".name")?.textContent || "",
        };
      }
    );
    console.log(`   Source directory: "${dirInfo?.name}"`);

    // We need to get the actual path. Let's evaluate by triggering a dragstart to capture data.
    const dragData = await page.evaluate(() => {
      const firstDir = document.querySelector(".file-item.directory");
      if (!firstDir) return null;

      // Trigger a dragstart to capture what data would be set
      const dataTransfer = new DataTransfer();
      const event = new DragEvent("dragstart", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      });
      firstDir.dispatchEvent(event);

      return {
        path: dataTransfer.getData("application/x-explorer-path"),
        name: dataTransfer.getData("application/x-explorer-name"),
        kind: dataTransfer.getData("application/x-explorer-kind"),
      };
    });
    console.log(`   Drag data captured: path="${dragData?.path}", name="${dragData?.name}", kind="${dragData?.kind}"`);

    if (!dragData?.path) {
      console.log("   WARNING: Could not capture drag data from dragstart. The dragstart handler may not be setting data.");
      await screenshot(page, "03-no-drag-data");
    }

    // Now simulate the full drag-and-drop to Quick Access section
    const result = await simulateDragDrop(
      page,
      ".file-item.directory",
      ".quick-access",
      {
        "application/x-explorer-path": dragData?.path || "/unknown",
        "application/x-explorer-name": dragData?.name || "unknown",
        "application/x-explorer-kind": "directory",
      }
    );
    console.log(`   Drag-drop result:`, result);

    await sleep(500); // Wait for state update

    await screenshot(page, "03-after-pin-drag");

    // Check if bookmark was added
    const bookmarksAfter = await page.$$eval(".user-bookmark", (els) =>
      els.map((el) => el.querySelector("span")?.textContent || "")
    );
    console.log(`   Bookmarks after: [${bookmarksAfter.join(", ")}]`);

    if (bookmarksAfter.length > bookmarksBefore.length) {
      console.log(`   SUCCESS: Bookmark was added! New bookmark: "${bookmarksAfter[bookmarksAfter.length - 1]}"`);
    } else {
      console.log("   ISSUE: Bookmark was NOT added after drag-and-drop");

      // Debug: Check if the drag-over visual feedback works
      console.log("\n   Debugging: Testing dragover visual feedback...");
      const dragOverResult = await page.evaluate(({ dragData }) => {
        const target = document.querySelector(".quick-access");
        if (!target) return { error: "Quick access not found" };

        const dataTransfer = new DataTransfer();
        for (const [type, value] of Object.entries(dragData)) {
          dataTransfer.setData(type, value);
        }

        const dragOverEvent = new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        });
        const prevented = !target.dispatchEvent(dragOverEvent);

        return {
          prevented,
          isDragOver: target.classList.contains("drag-over"),
          dataTransferTypes: Array.from(dataTransfer.types),
        };
      }, { dragData: {
        "application/x-explorer-path": dragData?.path || "/unknown",
        "application/x-explorer-name": dragData?.name || "unknown",
        "application/x-explorer-kind": "directory",
      }});
      console.log("   Dragover result:", dragOverResult);

      await screenshot(page, "03b-dragover-debug");
    }

    // ============================
    // TEST 2: Drag-to-move between directories
    // ============================
    console.log("\n4. Testing drag-to-move: Dragging a file/folder into a directory...");

    // We need at least 2 items (one to drag, one directory to drop into)
    if (directories.length >= 2) {
      const sourceName = items.find((i) => !i.isDir)?.name || directories[1].name;
      const targetDirName = directories[0].name;
      console.log(`   Will simulate dragging "${sourceName}" into "${targetDirName}"`);

      // Get actual paths
      const moveData = await page.evaluate(({ sourceName, targetDirName }) => {
        const allItems = Array.from(document.querySelectorAll(".file-item"));

        let sourceEl = null;
        let targetEl = null;
        for (const el of allItems) {
          const name = el.querySelector(".name")?.textContent;
          if (name === sourceName && !sourceEl) sourceEl = el;
          if (name === targetDirName && el.classList.contains("directory")) targetEl = el;
        }

        if (!sourceEl || !targetEl) return null;

        // Get source data via dragstart
        const dataTransfer = new DataTransfer();
        const event = new DragEvent("dragstart", {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        });
        sourceEl.dispatchEvent(event);

        return {
          sourcePath: dataTransfer.getData("application/x-explorer-path"),
          sourceName: dataTransfer.getData("application/x-explorer-name"),
          sourceKind: dataTransfer.getData("application/x-explorer-kind"),
          targetName: targetDirName,
        };
      }, { sourceName, targetDirName });

      console.log(`   Move data: source="${moveData?.sourcePath}", kind="${moveData?.sourceKind}"`);

      // Check that the target directory shows drop-target visual feedback on dragover
      const moveDropEffect = await page.evaluate(({ targetDirName, moveData }) => {
        const allItems = Array.from(document.querySelectorAll(".file-item"));
        const targetEl = allItems.find(
          (el) =>
            el.querySelector(".name")?.textContent === targetDirName &&
            el.classList.contains("directory")
        );
        if (!targetEl) return { error: "Target not found" };

        const dataTransfer = new DataTransfer();
        dataTransfer.setData("application/x-explorer-path", moveData?.sourcePath || "");
        dataTransfer.setData("application/x-explorer-name", moveData?.sourceName || "");
        dataTransfer.setData("application/x-explorer-kind", moveData?.sourceKind || "");

        const dragOverEvent = new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        });
        const prevented = !targetEl.dispatchEvent(dragOverEvent);

        return {
          prevented,
          dropEffect: dataTransfer.dropEffect,
          isDropTarget: targetEl.classList.contains("drop-target"),
        };
      }, { targetDirName, moveData });

      console.log(`   Move dragover - prevented: ${moveDropEffect.prevented}, dropEffect: "${moveDropEffect.dropEffect}", isDropTarget: ${moveDropEffect.isDropTarget}`);

      if (moveDropEffect.isDropTarget) {
        console.log("   SUCCESS: Directory shows drop-target visual feedback on dragover (move operation works)");
      } else {
        console.log("   ISSUE: Directory did NOT show drop-target feedback");
      }

      await screenshot(page, "04-move-dragover");

      // Clean up: dispatch dragleave
      await page.evaluate(({ targetDirName }) => {
        const allItems = Array.from(document.querySelectorAll(".file-item"));
        const targetEl = allItems.find(
          (el) =>
            el.querySelector(".name")?.textContent === targetDirName &&
            el.classList.contains("directory")
        );
        if (targetEl) {
          targetEl.dispatchEvent(new DragEvent("dragleave", { bubbles: true }));
        }
      }, { targetDirName });
    } else {
      console.log("   SKIPPED: Not enough directories to test move operation");
    }

    // ============================
    // TEST 3: Verify effectAllowed is "all" (the fix)
    // ============================
    console.log("\n5. Verifying effectAllowed fix (should be 'all')...");
    const effectAllowed = await page.evaluate(() => {
      const firstDir = document.querySelector(".file-item.directory");
      if (!firstDir) return null;

      const dataTransfer = new DataTransfer();
      const event = new DragEvent("dragstart", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      });
      firstDir.dispatchEvent(event);
      return dataTransfer.effectAllowed;
    });
    console.log(`   effectAllowed on dragstart: "${effectAllowed}"`);
    if (effectAllowed === "all") {
      console.log("   SUCCESS: effectAllowed is 'all' (compatible with sidebar's dropEffect='link')");
    } else {
      console.log(`   ISSUE: effectAllowed is "${effectAllowed}", expected "all"`);
    }

    // ============================
    // TEST 4: Verify sidebar accepts "link" drop effect
    // ============================
    console.log("\n6. Verifying sidebar dropEffect is 'link'...");
    const sidebarDropEffect = await page.evaluate(() => {
      const quickAccess = document.querySelector(".quick-access");
      if (!quickAccess) return null;

      const dataTransfer = new DataTransfer();
      dataTransfer.setData("application/x-explorer-kind", "directory");
      dataTransfer.setData("application/x-explorer-path", "/test/path");
      dataTransfer.setData("application/x-explorer-name", "test");

      const dragOverEvent = new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      });
      quickAccess.dispatchEvent(dragOverEvent);

      return dataTransfer.dropEffect;
    });
    console.log(`   Sidebar dropEffect on dragover: "${sidebarDropEffect}"`);
    if (sidebarDropEffect === "link") {
      console.log("   SUCCESS: Sidebar uses dropEffect='link' for pin operation");
    } else {
      console.log(`   ISSUE: Sidebar dropEffect is "${sidebarDropEffect}", expected "link"`);
    }

    // ============================
    // TEST 5: Verify file-item directories accept "move" drop effect
    // ============================
    console.log("\n7. Verifying file-item directory dropEffect is 'move'...");
    const dirDropEffect = await page.evaluate(() => {
      const firstDir = document.querySelector(".file-item.directory");
      if (!firstDir) return null;

      const dataTransfer = new DataTransfer();
      dataTransfer.setData("application/x-explorer-path", "/some/other/path");
      dataTransfer.setData("application/x-explorer-name", "other");
      dataTransfer.setData("application/x-explorer-kind", "directory");

      const dragOverEvent = new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      });
      firstDir.dispatchEvent(dragOverEvent);

      return dataTransfer.dropEffect;
    });
    console.log(`   FileItem directory dropEffect on dragover: "${dirDropEffect}"`);
    if (dirDropEffect === "move") {
      console.log("   SUCCESS: FileItem directories use dropEffect='move' for move operation");
    } else {
      console.log(`   ISSUE: FileItem directory dropEffect is "${dirDropEffect}", expected "move"`);
    }

    // ============================
    // TEST 6: Verify only directories can be dropped onto in file list
    // ============================
    console.log("\n8. Verifying only directories accept drops (files should reject)...");
    const fileDropTest = await page.evaluate(() => {
      const fileItem = document.querySelector(".file-item:not(.directory)");
      if (!fileItem) return { skipped: true, reason: "No file items found" };

      const dataTransfer = new DataTransfer();
      dataTransfer.setData("application/x-explorer-path", "/some/path");
      dataTransfer.setData("application/x-explorer-name", "test");
      dataTransfer.setData("application/x-explorer-kind", "file");

      const dragOverEvent = new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      });
      const prevented = !fileItem.dispatchEvent(dragOverEvent);

      return { prevented, isDropTarget: fileItem.classList.contains("drop-target") };
    });
    if (fileDropTest.skipped) {
      console.log(`   SKIPPED: ${fileDropTest.reason}`);
    } else {
      console.log(`   File item drop - prevented: ${fileDropTest.prevented}, isDropTarget: ${fileDropTest.isDropTarget}`);
      if (!fileDropTest.isDropTarget) {
        console.log("   SUCCESS: File items correctly reject drops");
      } else {
        console.log("   ISSUE: File items incorrectly accept drops");
      }
    }

    // ============================
    // TEST 7: Verify only directories can be pinned (files should be rejected)
    // ============================
    console.log("\n9. Verifying only directories can be pinned to Quick Access...");
    const filePinTest = await page.evaluate(() => {
      const quickAccess = document.querySelector(".quick-access");
      if (!quickAccess) return { error: "Quick access not found" };

      // Clear any existing bookmarks first by checking localStorage
      const before = JSON.parse(localStorage.getItem("explorer-bookmarks") || "[]");

      const dataTransfer = new DataTransfer();
      dataTransfer.setData("application/x-explorer-path", "/test/file.txt");
      dataTransfer.setData("application/x-explorer-name", "file.txt");
      dataTransfer.setData("application/x-explorer-kind", "file");

      const dropEvent = new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      });
      quickAccess.dispatchEvent(dropEvent);

      const after = JSON.parse(localStorage.getItem("explorer-bookmarks") || "[]");

      return {
        bookmarksBefore: before.length,
        bookmarksAfter: after.length,
        fileWasAdded: after.length > before.length,
      };
    });
    console.log(`   File pin test: bookmarks before=${filePinTest.bookmarksBefore}, after=${filePinTest.bookmarksAfter}`);
    if (!filePinTest.fileWasAdded) {
      console.log("   SUCCESS: Files are correctly rejected from being pinned");
    } else {
      console.log("   ISSUE: A file was incorrectly added as a bookmark");
    }

    // ============================
    // Final summary
    // ============================
    console.log("\n=== Final Screenshots ===");
    await screenshot(page, "05-final-state");

    // Check for any console errors
    const errors = consoleMsgs.filter((m) => m.startsWith("[error]"));
    if (errors.length > 0) {
      console.log("\nConsole errors:");
      errors.forEach((e) => console.log(`  ${e}`));
    }

    // Check for warnings
    const warnings = consoleMsgs.filter((m) => m.startsWith("[warning]"));
    if (warnings.length > 0) {
      console.log("\nConsole warnings:");
      warnings.slice(0, 5).forEach((w) => console.log(`  ${w}`));
    }

  } catch (err) {
    console.error("Test error:", err.message);
    await screenshot(page, "error");
  } finally {
    await browser.close();
    console.log("\n=== Tests Complete ===");
  }
}

main();
