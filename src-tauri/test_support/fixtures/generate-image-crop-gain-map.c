// Independent test input: compile against installed libavif, not the crop bridge.
#include <avif/avif.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static void require(avifResult result) {
    if (result != AVIF_RESULT_OK) { fprintf(stderr, "%s\n", avifResultToString(result)); exit(1); }
}
static void fill(avifImage * image, int gain) {
    avifRGBImage rgb;
    avifRGBImageSetDefaults(&rgb, image);
    rgb.format = AVIF_RGB_FORMAT_RGBA;
    require(avifRGBImageAllocatePixels(&rgb));
    for (uint32_t y = 0; y < rgb.height; ++y) {
        for (uint32_t x = 0; x < rgb.width; ++x) {
            uint8_t * p = rgb.pixels + y * rgb.rowBytes + x * 4;
            p[0] = gain ? x * 27 + y * 13 : x * 13;
            p[1] = gain == 2 ? x * 17 + y * 19 : (gain ? p[0] : y * 19);
            p[2] = gain == 2 ? x * 23 + y * 7 : (gain ? p[0] : 83);
            p[3] = gain || x % 3 ? 255 : 64;
        }
    }
    require(avifImageRGBToYUV(image, &rgb));
    avifRGBImageFreePixels(&rgb);
}
int main(int argc, char ** argv) {
    if (argc < 2 || argc > 4) return 1;
    const int oriented = argc >= 3 && strcmp(argv[2], "oriented") == 0;
    const int subsampled = argc >= 3 && strcmp(argv[2], "subsampled") == 0;
    const int icc = argc >= 3 && strcmp(argv[2], "icc") == 0;
    if (icc && argc != 4) return 1;
    avifImage * image = avifImageCreate(16, 12, 8, AVIF_PIXEL_FORMAT_YUV444);
    if (!image) return 1;
    image->matrixCoefficients = AVIF_MATRIX_COEFFICIENTS_IDENTITY;
    image->colorPrimaries = AVIF_COLOR_PRIMARIES_BT709;
    image->transferCharacteristics = AVIF_TRANSFER_CHARACTERISTICS_SRGB;
    image->clli.maxCLL = 3000; image->clli.maxPALL = 1000;
    fill(image, 0);
    if (oriented) {
        const avifCropRect aperture = { 2, 1, 12, 8 };
        avifDiagnostics diag;
        memset(&diag, 0, sizeof(diag));
        if (!avifCleanApertureBoxFromCropRect(&image->clap, &aperture, 16, 12, &diag)) return 1;
        image->transformFlags = AVIF_TRANSFORM_IROT | AVIF_TRANSFORM_IMIR;
        image->irot.angle = 1; image->imir.axis = 1;
    }
    image->gainMap = avifGainMapCreate();
    if (!image->gainMap) return 1;
    avifGainMap * gain = image->gainMap;
    gain->image = avifImageCreate(oriented ? 16 : 8, oriented ? 12 : 6, 8, subsampled ? AVIF_PIXEL_FORMAT_YUV420 : AVIF_PIXEL_FORMAT_YUV444);
    if (!gain->image) return 1;
    gain->image->matrixCoefficients = subsampled ? AVIF_MATRIX_COEFFICIENTS_BT601 : AVIF_MATRIX_COEFFICIENTS_IDENTITY;
    fill(gain->image, subsampled ? 2 : 1);
    for (int i = 0; i < 3; ++i) {
        gain->gainMapMax[i].n = subsampled ? 2 + i : 2;
        if (subsampled) { gain->gainMapGamma[i].n = 5 + i; gain->gainMapGamma[i].d = 4 + i; }
        gain->baseOffset[i].n = gain->alternateOffset[i].n = 1;
        gain->baseOffset[i].d = gain->alternateOffset[i].d = 64;
    }
    if (oriented) {
        // System libavif1.4.2 refuses equal-size CLAP gain maps. Reserve the
        // correctly ordered property for both items; the independent Python
        // fixture generator promotes its parsed box type without moving bytes.
        const uint32_t fields[8] = { 12, 1, 8, 1, 0, 1, UINT32_MAX, 1 };
        uint8_t payload[32];
        for (int i = 0; i < 8; ++i) {
            payload[i * 4] = (uint8_t)(fields[i] >> 24);
            payload[i * 4 + 1] = (uint8_t)(fields[i] >> 16);
            payload[i * 4 + 2] = (uint8_t)(fields[i] >> 8);
            payload[i * 4 + 3] = (uint8_t)fields[i];
        }
        require(avifImageAddOpaqueProperty(image, (const uint8_t *)"crop", payload, sizeof(payload)));
        require(avifImageAddOpaqueProperty(gain->image, (const uint8_t *)"crop", payload, sizeof(payload)));
    }
    gain->alternateHdrHeadroom.n = 2;
    gain->altColorPrimaries = AVIF_COLOR_PRIMARIES_BT709;
    gain->altTransferCharacteristics = AVIF_TRANSFER_CHARACTERISTICS_SMPTE2084;
    gain->altMatrixCoefficients = AVIF_MATRIX_COEFFICIENTS_IDENTITY;
    gain->altYUVRange = AVIF_RANGE_FULL;
    gain->altDepth = 12; gain->altPlaneCount = 3;
    gain->altCLLI.maxCLL = 6000; gain->altCLLI.maxPALL = 1400;
    if (icc) {
        FILE * profile = fopen(argv[3], "rb");
        uint8_t bytes[4096];
        if (!profile) return 1;
        const size_t count = fread(bytes, 1, sizeof(bytes), profile);
        if (ferror(profile) || !feof(profile) || fclose(profile) || !count) return 1;
        require(avifRWDataSet(&gain->altICC, bytes, count));
    }
    avifEncoder * encoder = avifEncoderCreate();
    if (!encoder) return 1;
    encoder->codecChoice = AVIF_CODEC_CHOICE_AOM;
    encoder->maxThreads = 2; encoder->speed = 10;
    encoder->quality = encoder->qualityAlpha = encoder->qualityGainMap = 100;
    avifRWData encoded = AVIF_DATA_EMPTY;
    require(avifEncoderWrite(encoder, image, &encoded));
    FILE * out = fopen(argv[1], "wb");
    if (!out || fwrite(encoded.data, encoded.size, 1, out) != 1 || fclose(out)) return 1;
    avifRWDataFree(&encoded); avifEncoderDestroy(encoder); avifImageDestroy(image);
    return 0;
}
