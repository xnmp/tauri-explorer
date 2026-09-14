<script lang="ts">
  import { avatarFallback } from "$lib/domain/git-avatar";
  import { requestGitAuthorAvatar } from "$lib/state/git-avatar-cache";

  const { name, email, gravatarEnabled }: { name: string; email: string; gravatarEnabled: boolean } = $props();
  const fallback = $derived(avatarFallback({ name, email }));
  let image = $state<string | null>(null);

  $effect(() => {
    const requestedEmail = email;
    const requestedConsent = gravatarEnabled;
    let current = true;
    image = null;
    const request = requestGitAuthorAvatar(requestedEmail, requestedConsent);
    void request.promise.then((value) => {
      if (current && requestedEmail === email && requestedConsent === gravatarEnabled) image = value;
    });
    return () => { current = false; request.cancel(); };
  });
</script>

<span class="avatar" data-testid="author-avatar" title={name || email} aria-hidden="true">
  {#if image}
    <img src={image} alt="" onerror={() => { image = null; }} />
  {:else}
    <span class="fallback" data-testid="author-avatar-fallback" style:background-color={fallback.color}>{fallback.initial}</span>
  {/if}
</span>

<style>
  .avatar, .fallback, img { display: grid; width: 20px; height: 20px; flex: 0 0 20px; border-radius: 50%; }
  .avatar { overflow: hidden; }
  img { object-fit: cover; }
  .fallback { place-items: center; color: white; font-size: 10px; font-weight: 700; line-height: 20px; text-shadow: 0 1px 1px rgb(0 0 0 / 35%); }
</style>
