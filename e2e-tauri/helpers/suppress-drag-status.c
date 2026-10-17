/* Native negative control: remove GTK's destination acknowledgement.
 * Loaded only into the private qualification session, never the product. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdlib.h>
#include <unistd.h>

typedef void (*DragStatus)(void *, unsigned int, unsigned int);

void gdk_drag_status(void *context, unsigned int action, unsigned int time) {
  const char *receipt = getenv("TAURI_DND_SUPPRESSED_ACK_RECEIPT");
  if (receipt && action) {
    int fd = open(receipt, O_WRONLY | O_CREAT | O_APPEND, 0600);
    if (fd >= 0) {
      const char marker[] = "suppressed GTK destination acknowledgement\n";
      (void)write(fd, marker, sizeof(marker) - 1);
      close(fd);
    }
  }
  DragStatus original = (DragStatus)dlsym(RTLD_NEXT, "gdk_drag_status");
  if (!original) _exit(91);
  original(context, receipt ? 0 : action, time);
}
