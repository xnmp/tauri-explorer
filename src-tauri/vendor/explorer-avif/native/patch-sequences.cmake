# Preserve sequence intent and an absent edit list in pinned libavif1.4.2.
# Each substitution accepts only the original or our exact patched fragment.
function(replace_pinned original replacement)
    string(FIND "${writer}" "${original}" found)
    if(found GREATER_EQUAL 0)
        string(REPLACE "${original}" "${replacement}" writer "${writer}")
    else()
        string(FIND "${writer}" "${replacement}" patched)
        if(patched LESS 0)
            message(FATAL_ERROR "Pinned AVIF writer patch no longer applies")
        endif()
    endif()
    set(writer "${writer}" PARENT_SCOPE)
endfunction()
set(writer_path "${CMAKE_CURRENT_BINARY_DIR}/avif-source/libavif-1.4.2/src/write.c")
file(READ "${writer_path}" writer)
set(unpatched_writer "${writer}")
replace_pinned([=[    const avifBool isSequence = (encoder->extraLayerCount == 0) && (encoder->data->frames.count > 1);]=] [=[    const avifBool isSequence = (encoder->extraLayerCount == 0) && !encoder->data->singleImage;]=])
replace_pinned([=[        if (encoder->repetitionCount < 0 && encoder->repetitionCount != AVIF_REPETITION_COUNT_INFINITE) {]=] [=[        if (encoder->repetitionCount < 0 && encoder->repetitionCount != AVIF_REPETITION_COUNT_INFINITE &&
            encoder->repetitionCount != AVIF_REPETITION_COUNT_UNKNOWN) {]=])
replace_pinned([=[            durationInTimescales = AVIF_INDEFINITE_DURATION64;
        } else {]=] [=[            durationInTimescales = AVIF_INDEFINITE_DURATION64;
        } else if (encoder->repetitionCount == AVIF_REPETITION_COUNT_UNKNOWN) {
            durationInTimescales = framesDurationInTimescales;
        } else {]=])
replace_pinned([=[            avifBoxMarker edts;
            AVIF_CHECKRES(avifRWStreamWriteBox(&s, "edts", AVIF_BOX_SIZE_TBD, &edts));
            uint32_t elstFlags = (encoder->repetitionCount != 0);
            avifBoxMarker elst;
            AVIF_CHECKRES(avifRWStreamWriteFullBox(&s, "elst", AVIF_BOX_SIZE_TBD, 1, elstFlags, &elst));
            AVIF_CHECKRES(avifRWStreamWriteU32(&s, 1));                          // unsigned int(32) entry_count;
            AVIF_CHECKRES(avifRWStreamWriteU64(&s, framesDurationInTimescales)); // unsigned int(64) segment_duration;
            AVIF_CHECKRES(avifRWStreamWriteU64(&s, 0));                          // int(64) media_time;
            AVIF_CHECKRES(avifRWStreamWriteU16(&s, 1));                          // int(16) media_rate_integer;
            AVIF_CHECKRES(avifRWStreamWriteU16(&s, 0));                          // int(16) media_rate_fraction = 0;
            AVIF_CHECKRES(avifRWStreamFinishBox(&s, elst));
            AVIF_CHECKRES(avifRWStreamFinishBox(&s, edts));]=] [=[            if (encoder->repetitionCount != AVIF_REPETITION_COUNT_UNKNOWN) {
                avifBoxMarker edts;
                AVIF_CHECKRES(avifRWStreamWriteBox(&s, "edts", AVIF_BOX_SIZE_TBD, &edts));
                uint32_t elstFlags = (encoder->repetitionCount != 0);
                avifBoxMarker elst;
                AVIF_CHECKRES(avifRWStreamWriteFullBox(&s, "elst", AVIF_BOX_SIZE_TBD, 1, elstFlags, &elst));
                AVIF_CHECKRES(avifRWStreamWriteU32(&s, 1));                          // unsigned int(32) entry_count;
                AVIF_CHECKRES(avifRWStreamWriteU64(&s, framesDurationInTimescales)); // unsigned int(64) segment_duration;
                AVIF_CHECKRES(avifRWStreamWriteU64(&s, 0));                          // int(64) media_time;
                AVIF_CHECKRES(avifRWStreamWriteU16(&s, 1));                          // int(16) media_rate_integer;
                AVIF_CHECKRES(avifRWStreamWriteU16(&s, 0));                          // int(16) media_rate_fraction = 0;
                AVIF_CHECKRES(avifRWStreamFinishBox(&s, elst));
                AVIF_CHECKRES(avifRWStreamFinishBox(&s, edts));
            }]=])
if(NOT writer STREQUAL unpatched_writer)
    file(WRITE "${writer_path}" "${writer}")
endif()
