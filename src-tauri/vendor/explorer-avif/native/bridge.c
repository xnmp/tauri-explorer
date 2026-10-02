#include "bridge.h"
#include <avif/avif.h>
#include <stdio.h>
#include <string.h>

#define MAX_BYTES ((size_t)200 * 1024 * 1024)
#define MAX_PIXELS (256U * 1024U * 1024U / 8U)
#define MAX_WORK_PIXELS ((uint64_t)256 * 1024 * 1024)
#define MAX_FRAMES 1024

int explorer_avif_is_avif(const uint8_t * bytes, size_t size)
{
    const avifROData data = { bytes, size };
    return size <= MAX_BYTES && avifPeekCompatibleFileType(&data);
}

static int fail(ExplorerAvifOutput * output, const char * message)
{
    snprintf(output->error, sizeof(output->error), "%s", message);
    return 0;
}

static int check(ExplorerAvifOutput * output, avifResult result)
{
    return result == AVIF_RESULT_OK ? 1 : fail(output, avifResultToString(result));
}

static int valid_size(uint32_t width, uint32_t height)
{
    return width != 0 && height != 0 && width <= 16384 && height <= 16384 && (uint64_t)width * height <= MAX_PIXELS;
}

static avifDecoder * open_decoder(const uint8_t * bytes, size_t size, ExplorerAvifOutput * output)
{
    if (size == 0 || size > MAX_BYTES) {
        fail(output, "AVIF file exceeds the crop input limit");
        return NULL;
    }
    avifDecoder * decoder = avifDecoderCreate();
    if (!decoder) {
        fail(output, "Cannot allocate AVIF decoder");
        return NULL;
    }
    decoder->codecChoice = AVIF_CODEC_CHOICE_AOM;
    decoder->maxThreads = 2;
    decoder->imageContentToDecode = AVIF_IMAGE_CONTENT_ALL | AVIF_IMAGE_CONTENT_SAMPLE_TRANSFORMS;
    decoder->imageSizeLimit = MAX_PIXELS;
    decoder->imageDimensionLimit = 16384;
    decoder->imageCountLimit = MAX_FRAMES;
    if (!check(output, avifDecoderSetIOMemory(decoder, bytes, size)) || !check(output, avifDecoderParse(decoder))) {
        avifDecoderDestroy(decoder);
        return NULL;
    }
    if (!valid_size(decoder->image->width, decoder->image->height) || decoder->imageCount < 1 ||
        decoder->imageCount > MAX_FRAMES ||
        (uint64_t)decoder->image->width * decoder->image->height * (uint32_t)decoder->imageCount > MAX_WORK_PIXELS) {
        fail(output, "AVIF dimensions or animation work exceed the crop limit");
        avifDecoderDestroy(decoder);
        return NULL;
    }
    return decoder;
}

// MIAF applies clean aperture, then counterclockwise rotation, then mirroring.
// Coordinates are kept in decoded pixel space; no resampling is involved.
static int geometry(const avifImage * image, avifCropRect * aperture, uint32_t * width, uint32_t * height,
                    uint8_t * angle, int * mirror, ExplorerAvifOutput * output)
{
    if (!valid_size(image->width, image->height)) {
        return fail(output, "Decoded AVIF dimensions exceed the crop limit");
    }
    aperture->x = aperture->y = 0;
    aperture->width = image->width;
    aperture->height = image->height;
    if (image->transformFlags & AVIF_TRANSFORM_CLAP) {
        avifDiagnostics diag;
        memset(&diag, 0, sizeof(diag));
        if (!avifCropRectFromCleanApertureBox(aperture, &image->clap, image->width, image->height, &diag)) {
            return fail(output, "Invalid AVIF clean aperture");
        }
    }
    *angle = (image->transformFlags & AVIF_TRANSFORM_IROT) ? image->irot.angle : 0;
    *mirror = (image->transformFlags & AVIF_TRANSFORM_IMIR) ? image->imir.axis : -1;
    if (*angle > 3 || *mirror > 1) {
        return fail(output, "Invalid AVIF orientation");
    }
    *width = (*angle & 1) ? aperture->height : aperture->width;
    *height = (*angle & 1) ? aperture->width : aperture->height;
    return valid_size(*width, *height) ? 1 : fail(output, "Invalid AVIF presentation size");
}

static void source_point(uint32_t x, uint32_t y, const avifCropRect * aperture, uint8_t angle, int mirror,
                         uint32_t width, uint32_t height, uint32_t * sx, uint32_t * sy)
{
    if (mirror == 0) y = height - 1 - y;
    if (mirror == 1) x = width - 1 - x;
    switch (angle) {
        case 1: *sx = aperture->width - 1 - y; *sy = x; break;
        case 2: *sx = aperture->width - 1 - x; *sy = aperture->height - 1 - y; break;
        case 3: *sx = y; *sy = aperture->height - 1 - x; break;
        default: *sx = x; *sy = y; break;
    }
    *sx += aperture->x;
    *sy += aperture->y;
}

static int pixels(const avifImage * image, const ExplorerAvifRect * selected, avifRGBImage * result,
                  ExplorerAvifOutput * output)
{
    avifCropRect aperture;
    uint32_t width, height;
    uint8_t angle;
    int mirror;
    if (!geometry(image, &aperture, &width, &height, &angle, &mirror, output)) return 0;
    ExplorerAvifRect full = { 0, 0, width, height };
    const ExplorerAvifRect * crop = selected ? selected : &full;
    if (crop->left >= crop->right || crop->top >= crop->bottom || crop->right > width || crop->bottom > height) {
        return fail(output, "Choose a nonempty crop inside the AVIF image");
    }
    avifRGBImage source;
    avifRGBImageSetDefaults(&source, image);
    source.format = AVIF_RGB_FORMAT_RGBA;
    if (!check(output, avifRGBImageAllocatePixels(&source))) return 0;
    int ok = 0;
    if (!check(output, avifImageYUVToRGB(image, &source))) goto cleanup;
    avifRGBImageSetDefaults(result, image);
    result->format = AVIF_RGB_FORMAT_RGBA;
    result->width = crop->right - crop->left;
    result->height = crop->bottom - crop->top;
    if (!check(output, avifRGBImageAllocatePixels(result))) goto cleanup;
    const size_t pixel_size = avifRGBImagePixelSize(&source);
    for (uint32_t y = 0; y < result->height; ++y) {
        for (uint32_t x = 0; x < result->width; ++x) {
            uint32_t sx, sy;
            source_point(x + crop->left, y + crop->top, &aperture, angle, mirror, width, height, &sx, &sy);
            memcpy(result->pixels + (size_t)y * result->rowBytes + (size_t)x * pixel_size,
                   source.pixels + (size_t)sy * source.rowBytes + (size_t)sx * pixel_size, pixel_size);
        }
    }
    ok = 1;
cleanup:
    avifRGBImageFreePixels(&source);
    return ok;
}

static void metadata(const avifDecoder * decoder, const avifRGBImage * rgb, ExplorerAvifOutput * output)
{
    output->metadata.width = rgb->width;
    output->metadata.height = rgb->height;
    output->metadata.depth = rgb->depth;
    output->metadata.frame_count = (uint32_t)decoder->imageCount;
    output->metadata.repetitions = decoder->repetitionCount;
    output->metadata.timescale = decoder->timescale;
    output->metadata.frame_duration = decoder->imageTiming.durationInTimescales;
    output->metadata.color_primaries = decoder->image->colorPrimaries;
    output->metadata.transfer_function = decoder->image->transferCharacteristics;
    output->metadata.alpha_present = (uint32_t)decoder->alphaPresent;
    output->metadata.max_cll = decoder->image->clli.maxCLL;
    output->metadata.max_pall = decoder->image->clli.maxPALL;
    output->metadata.aspect_horizontal = (decoder->image->transformFlags & AVIF_TRANSFORM_PASP) ? decoder->image->pasp.hSpacing : 1;
    output->metadata.aspect_vertical = (decoder->image->transformFlags & AVIF_TRANSFORM_PASP) ? decoder->image->pasp.vSpacing : 1;
    output->metadata.sequence_present = (uint32_t)decoder->imageSequenceTrackPresent;
    const avifGainMap * gain = decoder->image->gainMap;
    if (gain && gain->image) {
        output->metadata.gain_map_present = 1;
        output->metadata.gain_width = gain->image->width;
        output->metadata.gain_height = gain->image->height;
        uint32_t * p = output->metadata.gain_parameters;
        for (int c = 0; c < 3; ++c) {
            *p++ = (uint32_t)gain->gainMapMin[c].n; *p++ = gain->gainMapMin[c].d;
            *p++ = (uint32_t)gain->gainMapMax[c].n; *p++ = gain->gainMapMax[c].d;
            *p++ = gain->gainMapGamma[c].n; *p++ = gain->gainMapGamma[c].d;
            *p++ = (uint32_t)gain->baseOffset[c].n; *p++ = gain->baseOffset[c].d;
            *p++ = (uint32_t)gain->alternateOffset[c].n; *p++ = gain->alternateOffset[c].d;
        }
        *p++ = gain->baseHdrHeadroom.n; *p++ = gain->baseHdrHeadroom.d;
        *p++ = gain->alternateHdrHeadroom.n; *p++ = gain->alternateHdrHeadroom.d;
        *p++ = (uint32_t)gain->useBaseColorSpace;
        *p++ = gain->altColorPrimaries; *p++ = gain->altTransferCharacteristics;
        *p++ = gain->altMatrixCoefficients; *p++ = (uint32_t)gain->altYUVRange;
        *p++ = gain->altDepth; *p++ = gain->altPlaneCount;
        *p++ = gain->altCLLI.maxCLL; *p++ = gain->altCLLI.maxPALL;
    }
}

int explorer_avif_decode_frame(const uint8_t * bytes, size_t size, uint32_t index, ExplorerAvifOutput * output)
{
    avifDecoder * decoder = open_decoder(bytes, size, output);
    if (!decoder) return 0;
    avifRGBImage rgb;
    memset(&rgb, 0, sizeof(rgb));
    int ok = 0;
    if (index >= (uint32_t)decoder->imageCount) {
        fail(output, "AVIF frame index is out of bounds");
        goto cleanup;
    }
    if (!check(output, avifDecoderNthImage(decoder, index)) || !pixels(decoder->image, NULL, &rgb, output)) goto cleanup;
    metadata(decoder, &rgb, output);
    output->data = rgb.pixels;
    output->size = (size_t)rgb.rowBytes * rgb.height;
    rgb.pixels = NULL; // Transfer to the Rust-owned output handle.
    ok = 1;
cleanup:
    avifRGBImageFreePixels(&rgb);
    avifDecoderDestroy(decoder);
    return ok;
}

int explorer_avif_tone_map_frame(const uint8_t * bytes, size_t size, float headroom, ExplorerAvifOutput * output)
{
    avifDecoder * decoder = open_decoder(bytes, size, output);
    if (!decoder) return 0;
    avifRGBImage rgb;
    memset(&rgb, 0, sizeof(rgb));
    int ok = 0;
    if (!check(output, avifDecoderNextImage(decoder))) goto cleanup;
    if (!decoder->image->gainMap || !decoder->image->gainMap->image) {
        fail(output, "AVIF has no gain map"); goto cleanup;
    }
    avifRGBImageSetDefaults(&rgb, decoder->image);
    rgb.format = AVIF_RGB_FORMAT_RGBA;
    rgb.depth = 16;
    rgb.isFloat = AVIF_TRUE;
    avifDiagnostics diag;
    memset(&diag, 0, sizeof(diag));
    if (!check(output, avifImageApplyGainMap(decoder->image, decoder->image->gainMap, headroom,
               decoder->image->colorPrimaries, AVIF_TRANSFER_CHARACTERISTICS_LINEAR, &rgb, NULL, &diag))) goto cleanup;
    metadata(decoder, &rgb, output);
    output->data = rgb.pixels;
    output->size = (size_t)rgb.rowBytes * rgb.height;
    rgb.pixels = NULL;
    ok = 1;
cleanup:
    avifRGBImageFreePixels(&rgb);
    avifDecoderDestroy(decoder);
    return ok;
}

// Expand the gain map using libavif's own tone-mapping scaler before selecting
// pixels. This keeps fractional crop origins aligned with the base pixel grid.
// The image transform applies to both the base image and the gain map.
static int crop_gain_map(const avifImage * source, avifImage * target, const ExplorerAvifRect * crop,
                         ExplorerAvifOutput * output)
{
    if (!source->gainMap) return 1;
    if (!source->gainMap->image || !valid_size(source->gainMap->image->width, source->gainMap->image->height)) {
        return fail(output, "Invalid AVIF gain map dimensions");
    }
    avifImage * scaled = avifImageCreateEmpty();
    if (!scaled) return fail(output, "Cannot allocate AVIF gain map");
    avifRGBImage rgb;
    memset(&rgb, 0, sizeof(rgb));
    int ok = 0;
    avifDiagnostics diag;
    memset(&diag, 0, sizeof(diag));
    const avifCropRect full = { 0, 0, source->gainMap->image->width, source->gainMap->image->height };
    if (!check(output, avifImageSetViewRect(scaled, source->gainMap->image, &full)) ||
        !check(output, avifImageScale(scaled, source->width, source->height, &diag))) goto cleanup;
    scaled->transformFlags = source->transformFlags & (AVIF_TRANSFORM_CLAP | AVIF_TRANSFORM_IROT | AVIF_TRANSFORM_IMIR);
    scaled->clap = source->clap;
    scaled->irot = source->irot;
    scaled->imir = source->imir;
    if (!pixels(scaled, crop, &rgb, output)) goto cleanup;
    avifImage * gain_image = target->gainMap->image;
    gain_image->width = rgb.width;
    gain_image->height = rgb.height;
    gain_image->depth = rgb.depth;
    gain_image->yuvFormat = AVIF_PIXEL_FORMAT_YUV444;
    gain_image->matrixCoefficients = AVIF_MATRIX_COEFFICIENTS_IDENTITY;
    gain_image->yuvRange = AVIF_RANGE_FULL;
    gain_image->transformFlags = AVIF_TRANSFORM_NONE;
    target->gainMap->altYUVRange = source->gainMap->altYUVRange;
    if (!check(output, avifImageRGBToYUV(gain_image, &rgb))) goto cleanup;
    ok = 1;
cleanup:
    avifRGBImageFreePixels(&rgb);
    avifImageDestroy(scaled);
    return ok;
}

int explorer_avif_crop(const uint8_t * bytes, size_t size, const ExplorerAvifRect * crop, ExplorerAvifOutput * output)
{
    avifDecoder * decoder = open_decoder(bytes, size, output);
    if (!decoder) return 0;
    avifEncoder * encoder = avifEncoderCreate();
    avifImage * target = NULL;
    avifRGBImage rgb;
    avifRWData encoded = AVIF_DATA_EMPTY;
    memset(&rgb, 0, sizeof(rgb));
    int ok = 0;
    if (!encoder) { fail(output, "Cannot allocate AVIF encoder"); goto cleanup; }
    encoder->codecChoice = AVIF_CODEC_CHOICE_AOM;
    encoder->maxThreads = 2;
    encoder->speed = AVIF_SPEED_FASTEST;
    encoder->quality = AVIF_QUALITY_LOSSLESS;
    encoder->qualityAlpha = AVIF_QUALITY_LOSSLESS;
    encoder->qualityGainMap = AVIF_QUALITY_LOSSLESS;
    encoder->timescale = decoder->timescale;
    encoder->repetitionCount = decoder->repetitionCount;
    for (int index = 0; index < decoder->imageCount; ++index) {
        if (!check(output, avifDecoderNextImage(decoder)) || !pixels(decoder->image, crop, &rgb, output)) goto cleanup;
        if (rgb.depth != 8 && rgb.depth != 10 && rgb.depth != 12 && rgb.depth != 16) {
            fail(output, "Unsupported AVIF sample depth"); goto cleanup;
        }
        if (index == 0) metadata(decoder, &rgb, output);
        if (rgb.depth == 16) encoder->sampleTransformRecipe = AVIF_SAMPLE_TRANSFORM_BIT_DEPTH_EXTENSION_8B_8B;
        target = avifImageCreate(rgb.width, rgb.height, rgb.depth, AVIF_PIXEL_FORMAT_YUV444);
        if (!target) { fail(output, "Cannot allocate cropped AVIF image"); goto cleanup; }
        if (!check(output, avifImageCopy(target, decoder->image, 0))) goto cleanup;
        target->width = rgb.width;
        target->height = rgb.height;
        target->depth = rgb.depth;
        target->yuvFormat = AVIF_PIXEL_FORMAT_YUV444;
        target->alphaPremultiplied = rgb.alphaPremultiplied;
        // Crop coordinates/orientation are baked into pixels. Remove old tags
        // rather than retain stale dimensions or invite a second rotation.
        avifRWDataFree(&target->exif);
        avifRWDataFree(&target->xmp);
        // Lossless identity/full-range YUV444 stores the decoded RGB values
        // without introducing another chroma-subsampling or quantization loss.
        target->matrixCoefficients = AVIF_MATRIX_COEFFICIENTS_IDENTITY;
        target->yuvRange = AVIF_RANGE_FULL;
        target->transformFlags = decoder->image->transformFlags & AVIF_TRANSFORM_PASP;
        target->pasp = decoder->image->pasp;
        if ((decoder->image->transformFlags & AVIF_TRANSFORM_IROT) && (decoder->image->irot.angle & 1)) {
            target->pasp.hSpacing = decoder->image->pasp.vSpacing;
            target->pasp.vSpacing = decoder->image->pasp.hSpacing;
        }
        if (!check(output, avifImageRGBToYUV(target, &rgb)) || !crop_gain_map(decoder->image, target, crop, output)) goto cleanup;
        const avifAddImageFlags flags = !decoder->imageSequenceTrackPresent ? AVIF_ADD_IMAGE_FLAG_SINGLE : AVIF_ADD_IMAGE_FLAG_NONE;
        if (!check(output, avifEncoderAddImage(encoder, target, decoder->imageTiming.durationInTimescales, flags))) goto cleanup;
        avifRGBImageFreePixels(&rgb);
        avifImageDestroy(target);
        target = NULL;
    }
    if (!check(output, avifEncoderFinish(encoder, &encoded))) goto cleanup;
    if (encoded.size == 0 || encoded.size > MAX_BYTES) {
        fail(output, "Encoded AVIF crop exceeds the output limit"); goto cleanup;
    }
    output->data = encoded.data;
    output->size = encoded.size;
    encoded.data = NULL;
    encoded.size = 0;
    ok = 1;
cleanup:
    avifRWDataFree(&encoded);
    avifRGBImageFreePixels(&rgb);
    if (target) avifImageDestroy(target);
    if (encoder) avifEncoderDestroy(encoder);
    avifDecoderDestroy(decoder);
    return ok;
}

void explorer_avif_free(ExplorerAvifOutput * output)
{
    avifRWData data = { output->data, output->size };
    avifRWDataFree(&data);
    output->data = NULL;
    output->size = 0;
}
