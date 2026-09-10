/** Window presentation state: automatic layout reveal pauses while a user owns
 * a resize. Each gesture retires only its own lease, including capture failure. */
export function createResizeActivity() {
  let count = $state(0);
  return {
    get active() { return count > 0; },
    begin() {
      count += 1;
      let retired = false;
      return () => { if (!retired) { retired = true; count -= 1; } };
    },
  };
}
export const resizeActivity = createResizeActivity();
