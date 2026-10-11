# Layout delivery contract
FileList owns measured content width; TilesView consumes it for row chunking, navigation and CSS tracks. Keep the existing column formula and virtualization. Publish width-driven DOM updates within ResizeObserver delivery, before paint, rather than deferring to another frame. No new domain interface is needed.
