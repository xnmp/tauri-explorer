<!--
  SettingToggle — the Settings switch: a visually restyled checkbox. Extra
  attributes (class, data-testid) are forwarded to the input.
-->
<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements";

  interface Props extends Omit<HTMLInputAttributes, "type"> {
    checked: boolean;
    onchange: HTMLInputAttributes["onchange"];
  }

  const { checked, onchange, ...rest }: Props = $props();
</script>

<label class="toggle">
  <input type="checkbox" {...rest} {checked} {onchange} />
  <span class="toggle-slider"></span>
</label>

<style>
  .toggle {
    position: relative;
    display: inline-block;
    flex: 0 0 44px;
    height: 24px;
    cursor: pointer;
  }

  .toggle input {
    opacity: 0;
    width: 0;
    height: 0;
  }

  .toggle-slider {
    position: absolute;
    inset: 0;
    background: var(--control-fill-secondary);
    border: 1px solid var(--control-stroke);
    border-radius: 12px;
    transition:
      background-color var(--transition-fast),
      border-color var(--transition-fast);
  }

  .toggle-slider::before {
    content: "";
    position: absolute;
    height: 18px;
    width: 18px;
    left: 2px;
    bottom: 2px;
    background: var(--text-secondary);
    border-radius: 50%;
    transition: transform var(--transition-fast);
  }

  .toggle input:checked + .toggle-slider {
    background: var(--accent);
    border-color: var(--accent);
  }

  .toggle input:checked + .toggle-slider::before {
    transform: translateX(20px);
    background: var(--text-on-accent);
  }

  .toggle input:focus-visible + .toggle-slider {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: 2px;
  }
</style>
