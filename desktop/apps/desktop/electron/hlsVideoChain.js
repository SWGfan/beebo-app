'use strict'
// ============================================================================
// hlsVideoChain.js - the picture side of a live conversion, as pure functions.
// ----------------------------------------------------------------------------
// Used by hlsTranscoder.js (to build the real ffmpeg command) and by
// encoderCapabilities.js (to build the SAME filters for the start-up self-test),
// so "the probe passed" really means "this exact chain runs on this machine".
//
// Everything here is ffmpeg's own filters (LGPL-clean): zscale (libzimg),
// tonemap, libplacebo, tonemap_opencl, tonemap_vaapi. Nothing needs libx264.
// ============================================================================

// Preference order for turning HDR into SDR. GPU tone-mapping first (it leaves the
// processor free on an old PC), the processor's own zscale+tonemap last because it is
// the one that works everywhere the filters were built in.
const TONEMAP_ORDER = ['tonemap_vaapi', 'libplacebo', 'tonemap_opencl', 'zscale']

// Which ffmpeg filters each method needs to be built into the binary.
const TONEMAP_FILTERS = {
  zscale: ['zscale', 'tonemap'],
  libplacebo: ['libplacebo'],
  tonemap_opencl: ['tonemap_opencl'],
  tonemap_vaapi: ['tonemap_vaapi']
}

const TONEMAP_LABELS = {
  zscale: 'Processor (zscale + tonemap)',
  libplacebo: 'Graphics card (libplacebo / Vulkan)',
  tonemap_opencl: 'Graphics card (OpenCL)',
  tonemap_vaapi: 'Graphics card (VAAPI)',
  none: 'None (colours may look dull)'
}

const DEFAULT_VAAPI_DEVICE = '/dev/dri/renderD128'

/** Frames the encoder reads: Quick Sync takes NV12, everything else here takes planar 4:2:0. */
function pixFmtFor(encoder) {
  return encoder === 'h264_qsv' ? 'nv12' : 'yuv420p'
}

/** Can this tone-map method be combined with this encoder? (One -filter_hw_device per command.) */
function methodFitsEncoder(method, encoder) {
  if (method === 'tonemap_vaapi') return encoder === 'h264_vaapi'
  if (method === 'tonemap_opencl') return encoder !== 'h264_vaapi'
  return true
}

/** The working methods (from the probe) that suit this encoder, best first. */
function methodsForEncoder(workingMethods, encoder) {
  const have = new Set(workingMethods || [])
  return TONEMAP_ORDER.filter((m) => have.has(m) && methodFitsEncoder(m, encoder))
}

function vaapiInit(device) {
  return ['-init_hw_device', `vaapi=va:${device || DEFAULT_VAAPI_DEVICE}`, '-filter_hw_device', 'va']
}

/**
 * The filter graph for the video of one run.
 *   encoder    the H.264 encoder that will read the frames
 *   size       { width, height } the output size (width may be -2 = "keep the shape")
 *   tonemap    null (none) or one of TONEMAP_ORDER; only meaningful for HDR sources
 *   device     VAAPI render node (h264_vaapi only)
 *   scaleFlags e.g. 'bilinear' (a gentler, cheaper scaler for an old PC), or ''
 * Returns { initArgs, chain, hwOut } - initArgs go before -i, chain joins with commas.
 * The picture is made small BEFORE the (expensive) tone-map, so a 4K film played at 720p
 * tone-maps a 720p picture, not a 4K one.
 */
function videoFilterPlan({ encoder, size, tonemap = null, device = '', scaleFlags = '' }) {
  const flags = scaleFlags ? `:flags=${scaleFlags}` : ''
  const scale = `scale=${size.width}:${size.height}${flags}`
  const pix = pixFmtFor(encoder)
  const vaapi = encoder === 'h264_vaapi'
  const method = tonemap && methodFitsEncoder(tonemap, encoder) ? tonemap : null
  let initArgs = vaapi ? vaapiInit(device) : []
  const chain = []
  let hwOut = false

  if (method === 'tonemap_vaapi') {
    chain.push(scale, 'format=p010le', 'hwupload', 'tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709')
    hwOut = true
  } else if (method === 'tonemap_opencl') {
    initArgs = ['-init_hw_device', 'opencl=ocl', '-filter_hw_device', 'ocl']
    chain.push(scale, 'format=p010le', 'hwupload',
      // hable, not bt2390: upstream ffmpeg's tonemap_opencl has no bt2390 (only patched builds do).
      'tonemap_opencl=tonemap=hable:desat=0:r=tv:p=bt709:t=bt709:m=bt709:format=nv12',
      'hwdownload', 'format=nv12', `format=${pix}`)
  } else if (method === 'libplacebo') {
    // libplacebo scales and tone-maps in one pass, on the graphics card.
    chain.push(`libplacebo=w=${size.width}:h=${size.height}:tonemapping=bt.2390:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:format=yuv420p`, `format=${pix}`)
    if (vaapi) chain.push('format=nv12', 'hwupload')
  } else if (method === 'zscale') {
    chain.push(scale, 'zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv', `format=${pix}`)
    if (vaapi) chain.push('format=nv12', 'hwupload')
  } else {
    chain.push(scale, `format=${vaapi ? 'nv12' : pix}`)
    if (vaapi) chain.push('hwupload')
  }
  return { initArgs, chain, hwOut, method }
}

/** ffmpeg arguments that prove one tone-map method runs here: 5 frames of tagged-HDR test picture. */
function testTonemapArgs(method, { device = '' } = {}) {
  const encoder = method === 'tonemap_vaapi' ? 'h264_vaapi' : 'libopenh264'
  const plan = videoFilterPlan({ encoder, size: { width: 320, height: 180 }, tonemap: method, device })
  const chain = plan.chain.slice()
  if (plan.hwOut) chain.push('hwdownload', 'format=nv12')
  return ['-hide_banner', '-nostdin', '-v', 'error', ...plan.initArgs,
    '-f', 'lavfi', '-i', 'color=c=0x606060:s=640x360:r=25:d=1,format=yuv420p10le,setparams=colorspace=bt2020nc:color_primaries=bt2020:color_trc=smpte2084:range=tv',
    '-vf', chain.join(','), '-frames:v', '5', '-f', 'null', '-']
}

module.exports = {
  TONEMAP_ORDER,
  TONEMAP_FILTERS,
  TONEMAP_LABELS,
  DEFAULT_VAAPI_DEVICE,
  pixFmtFor,
  methodFitsEncoder,
  methodsForEncoder,
  vaapiInit,
  videoFilterPlan,
  testTonemapArgs
}
