# #823: video frames need an explicit type indicator

An extracted video frame looked like an ordinary image thumbnail. The existing
`isVideoFile` helper also routes audio cover art through the same ffmpeg API, so
it cannot identify which files should receive a video badge. Use the separate
video-only classification for presentation; retain the shared extraction path.

Tiles place a passive, contrast-backed play badge over the frame, outside the
loader so extraction failure cannot remove it. Compact views and fallbacks use
a consistent video icon across icon themes. Preview markers derive directly
from the selected entry, including loading/error states, independently of the
asynchronously fetched frame. Existing preview revision guards still protect
the frame itself. A marker is not a button and does not claim playback support.

Domain tests cover all recognized formats, uppercase, directories and audio
exclusions. Browser acceptance uses matched image/video content across views,
themes, zoom, thumbnail sizes, fallback and rapid selection changes. Existing
video revision/fullscreen tests verify the original interactions remain intact.
