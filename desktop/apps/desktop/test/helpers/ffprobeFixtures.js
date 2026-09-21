'use strict'
// Hand-written ffprobe JSON (-show_streams -show_format -of json shapes) for the formats a home
// theatre cares about. No file is decoded here: the shapes come from what ffprobe (ffmpeg 6.1-9.0)
// prints for such files, written out so classification and the playback decision tests do not need
// an encoder (or a licence) for Dolby Vision, HDR10+, Atmos or DTS:X, which ffmpeg cannot make.
// Every fixture is a complete probe result: { streams: [...], format: {...} }.

const disp = (over = {}) => ({ default: 0, dub: 0, original: 0, comment: 0, forced: 0, hearing_impaired: 0, visual_impaired: 0, attached_pic: 0, ...over })

function video(over = {}) {
  return {
    index: 0, codec_name: 'h264', profile: 'High', codec_type: 'video', codec_tag_string: '[0][0][0][0]',
    width: 1920, height: 1080, pix_fmt: 'yuv420p', level: 41, color_range: 'tv', color_space: 'bt709', color_transfer: 'bt709', color_primaries: 'bt709',
    field_order: 'progressive', r_frame_rate: '24000/1001', avg_frame_rate: '24000/1001', bit_rate: '8000000', disposition: disp({ default: 1 }), tags: {},
    ...over
  }
}

function audio(over = {}) {
  return {
    index: 1, codec_name: 'aac', profile: 'LC', codec_type: 'audio', codec_tag_string: '[0][0][0][0]', sample_fmt: 'fltp', sample_rate: '48000',
    channels: 2, channel_layout: 'stereo', bit_rate: '192000', disposition: disp({ default: 1 }), tags: { language: 'eng' },
    ...over
  }
}

const doviRecord = (o = {}) => ({
  side_data_type: 'DOVI configuration record', dv_version_major: 1, dv_version_minor: 0, dv_profile: 8, dv_level: 6,
  rpu_present_flag: 1, el_present_flag: 0, bl_present_flag: 1, dv_bl_signal_compatibility_id: 1, ...o
})

const hdr10 = (over = {}) => video({
  codec_name: 'hevc', profile: 'Main 10', codec_tag_string: '[0][0][0][0]', width: 3840, height: 2160, pix_fmt: 'yuv420p10le', level: 153,
  color_space: 'bt2020nc', color_transfer: 'smpte2084', color_primaries: 'bt2020', bits_per_raw_sample: '10', bit_rate: '60000000', ...over
})

const file = (streams, format = {}) => ({
  streams,
  format: { format_name: 'matroska,webm', duration: '7200.000000', bit_rate: '70000000', ...format }
})

const S = {
  video, audio, doviRecord,
  // ------------------------------------------------------------------ video
  sdr1080: () => file([video(), audio()], { bit_rate: '9000000' }),
  sdr720: () => file([video({ width: 1280, height: 720, level: 40 }), audio()], { bit_rate: '4000000' }),
  scope1080: () => file([video({ width: 1920, height: 800 }), audio()], { bit_rate: '9000000' }),
  uhd4kSdr: () => file([video({ codec_name: 'hevc', profile: 'Main', width: 3840, height: 2160, level: 153 }), audio()]),
  hdr10_4k: () => file([hdr10(), audio({ index: 1, codec_name: 'eac3', profile: '', channels: 6, channel_layout: '5.1(side)', bit_rate: '768000' })]),
  hdr10Plus_4k: () => file([hdr10({ side_data_list: [{ side_data_type: 'Mastering display metadata' }, { side_data_type: 'Content light level metadata', max_content: 1000, max_average: 400 }, { side_data_type: 'HDR Dynamic Metadata SMPTE2094-40 (HDR10+)' }] }), audio({ codec_name: 'eac3', channels: 6, channel_layout: '5.1(side)' })]),
  // HDR10+ that ffprobe only shows on the first frames (the extra -show_frames call finds it)
  hdr10_4k_plusInFrames: () => file([hdr10(), audio({ codec_name: 'eac3', channels: 6, channel_layout: '5.1(side)' })]),
  hlg4k: () => file([hdr10({ color_transfer: 'arib-std-b67' }), audio({ codec_name: 'ac3', channels: 6, channel_layout: '5.1(side)' })]),
  hlg1080: () => file([video({ codec_name: 'hevc', profile: 'Main 10', pix_fmt: 'yuv420p10le', color_transfer: 'arib-std-b67', color_primaries: 'bt2020', color_space: 'bt2020nc' }), audio()], { format_name: 'mpegts', bit_rate: '15000000' }),
  // Dolby Vision profile 5 (IPT-PQ-C2): tagged with the BT.2020 / PQ container fields but no fallback
  dv5: () => file([hdr10({ codec_tag_string: 'dvh1', side_data_list: [doviRecord({ dv_profile: 5, dv_level: 9, dv_bl_signal_compatibility_id: 0 })] }), audio({ codec_name: 'eac3', channels: 6, channel_layout: '5.1(side)' })], { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' }),
  // Profile 8.1 (HDR10-compatible) - streaming rips, the common case
  dv81: () => file([hdr10({ side_data_list: [doviRecord({ dv_profile: 8, dv_bl_signal_compatibility_id: 1 })] }), audio({ codec_name: 'eac3', profile: 'Dolby Digital Plus + Dolby Atmos', channels: 6, channel_layout: '5.1(side)' })]),
  // Profile 8.4 (HLG-compatible)
  dv84: () => file([hdr10({ color_transfer: 'arib-std-b67', side_data_list: [doviRecord({ dv_profile: 8, dv_bl_signal_compatibility_id: 4 })] }), audio({ codec_name: 'eac3', channels: 6, channel_layout: '5.1(side)' })]),
  // Profile 8.2 (SDR-compatible base)
  dv82: () => file([video({ codec_name: 'hevc', profile: 'Main 10', width: 1920, height: 1080, pix_fmt: 'yuv420p10le', side_data_list: [doviRecord({ dv_profile: 8, dv_bl_signal_compatibility_id: 2 })] }), audio()]),
  // Profile 7 single-track dual layer remux (UHD Blu-ray, FEL): el_present, Blu-ray compatible base
  dv7fel: () => file([hdr10({ side_data_list: [doviRecord({ dv_profile: 7, dv_level: 6, el_present_flag: 1, dv_bl_signal_compatibility_id: 6 })] }), audio({ codec_name: 'truehd', profile: 'Dolby TrueHD + Dolby Atmos', channels: 8, channel_layout: '7.1', bit_rate: '' })]),
  // DV 8.1 with HDR10+ frames too (hybrid)
  dv81Plus: () => file([hdr10({ side_data_list: [doviRecord({ dv_profile: 8, dv_bl_signal_compatibility_id: 1 }), { side_data_type: 'HDR Dynamic Metadata SMPTE2094-40 (HDR10+)' }] }), audio()]),
  // Dolby Vision tag but no configuration record survived (an odd muxer)
  dvTagOnly: () => file([hdr10({ codec_tag_string: 'dvhe' }), audio()]),
  av1Hdr: () => file([video({ codec_name: 'av1', profile: 'Main', width: 3840, height: 2160, pix_fmt: 'yuv420p10le', color_space: 'bt2020nc', color_transfer: 'smpte2084', color_primaries: 'bt2020' }), audio({ codec_name: 'opus', channels: 2, profile: '' })], { format_name: 'matroska,webm' }),
  h264_10bit: () => file([video({ profile: 'High 10', pix_fmt: 'yuv420p10le', bits_per_raw_sample: '10' }), audio()], { bit_rate: '9000000' }),
  mpeg2Dvd: () => file([video({ codec_name: 'mpeg2video', profile: 'Main', width: 720, height: 480, pix_fmt: 'yuv420p', field_order: 'tt', level: 8 }), audio({ codec_name: 'ac3', channels: 6, channel_layout: '5.1(side)' })], { format_name: 'mpeg', bit_rate: '6000000' }),
  uhd8k: () => file([hdr10({ width: 7680, height: 4320, level: 186 }), audio()]),
  // ------------------------------------------------------------------ audio (one track on a 4K HDR10 picture)
  withAudio: (a, v) => file([v || hdr10(), a]),
  aacStereo: () => audio(),
  dd51: () => audio({ codec_name: 'ac3', profile: '', channels: 6, channel_layout: '5.1(side)', bit_rate: '640000' }),
  ddp51: () => audio({ codec_name: 'eac3', profile: '', channels: 6, channel_layout: '5.1(side)', bit_rate: '768000' }),
  ddp71: () => audio({ codec_name: 'eac3', profile: '', channels: 8, channel_layout: '7.1', bit_rate: '1024000' }),
  // Dolby Digital Plus with Dolby Atmos (JOC): 5.1 bed + objects, streaming services (Netflix, Disney+, Apple TV+)
  ddpAtmos: () => audio({ codec_name: 'eac3', profile: 'Dolby Digital Plus + Dolby Atmos', channels: 6, channel_layout: '5.1(side)', bit_rate: '768000' }),
  truehd51: () => audio({ codec_name: 'truehd', profile: '', channels: 6, channel_layout: '5.1(side)', bit_rate: '' }),
  truehd71: () => audio({ codec_name: 'truehd', profile: '', channels: 8, channel_layout: '7.1', bit_rate: '' }),
  // Atmos carried in TrueHD (UHD Blu-ray): the 7.1 bed (ffprobe counts the bed channels)
  truehdAtmos: () => audio({ codec_name: 'truehd', profile: 'Dolby TrueHD + Dolby Atmos', channels: 8, channel_layout: '7.1', bit_rate: '' }),
  dtsCore: () => audio({ codec_name: 'dts', profile: 'DTS', channels: 6, channel_layout: '5.1(side)', bit_rate: '1536000' }),
  dtsEs: () => audio({ codec_name: 'dts', profile: 'DTS-ES', channels: 7, channel_layout: '6.1', bit_rate: '1536000' }),
  dtsHra: () => audio({ codec_name: 'dts', profile: 'DTS-HD HRA', channels: 8, channel_layout: '7.1', bit_rate: '3000000' }),
  dtsHdMa51: () => audio({ codec_name: 'dts', profile: 'DTS-HD MA', channels: 6, channel_layout: '5.1(side)', bit_rate: '' }),
  dtsHdMa71: () => audio({ codec_name: 'dts', profile: 'DTS-HD MA', channels: 8, channel_layout: '7.1', bit_rate: '' }),
  dtsX: () => audio({ codec_name: 'dts', profile: 'DTS-HD MA + DTS:X', channels: 8, channel_layout: '7.1', bit_rate: '' }),
  // An older ffmpeg prints no Atmos profile; only the track title says so
  ddpAtmosTitleOnly: () => audio({ codec_name: 'eac3', profile: '', channels: 6, channel_layout: '5.1(side)', tags: { language: 'eng', title: 'English Dolby Atmos 5.1' } }),
  flac51: () => audio({ codec_name: 'flac', profile: '', channels: 6, channel_layout: '5.1(side)' }),
  opus51: () => audio({ codec_name: 'opus', profile: '', channels: 6, channel_layout: '5.1(side)' })
}

module.exports = S
