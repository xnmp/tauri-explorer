#ifndef EXPLORER_AVIF_BRIDGE_H
#define EXPLORER_AVIF_BRIDGE_H
#include <stddef.h>
#include <stdint.h>

typedef struct {
    uint32_t left, top, right, bottom;
} ExplorerAvifRect;

typedef struct {
    uint32_t width, height, depth, frame_count;
    int32_t repetitions;
    uint64_t timescale, frame_duration;
    uint32_t color_primaries, transfer_function, alpha_present;
    uint32_t max_cll, max_pall, aspect_horizontal, aspect_vertical, sequence_present;
    uint32_t gain_map_present, gain_width, gain_height, gain_parameters[43];
} ExplorerAvifMetadata;

typedef struct {
    uint8_t * data;
    size_t size;
    ExplorerAvifMetadata metadata;
    char error[512];
} ExplorerAvifOutput;

int explorer_avif_crop(const uint8_t * bytes, size_t size, const ExplorerAvifRect * crop, ExplorerAvifOutput * output);
int explorer_avif_decode_frame(const uint8_t * bytes, size_t size, uint32_t index, ExplorerAvifOutput * output);
int explorer_avif_tone_map_frame(const uint8_t * bytes, size_t size, float headroom, ExplorerAvifOutput * output);
void explorer_avif_free(ExplorerAvifOutput * output);
int explorer_avif_is_avif(const uint8_t * bytes, size_t size);
#endif
