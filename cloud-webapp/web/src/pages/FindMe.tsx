import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  SearchResponse,
  MatchResult,
  FeedbackRequest,
  ListReferencesResponse,
  ReferenceUpload,
  SearchByUploadRequest,
  AnchorSuggestion,
  SelfieCheckResponse,
  SelfieFaceReason,
  SelfieFaceWarning,
  FeedbackBatchRequest,
  FeedbackBatchResponse,
} from '@cloud-webapp/shared';
import { SelfieFaceReasonSchema } from '@cloud-webapp/shared';
import {
  apiGet,
  apiUpload,
  apiPost,
  ApiError,
} from '../lib/api.js';
import {
  OriginalsFetcher,
  PREFETCH_MAX_PHOTOS,
  PREFETCH_DEBOUNCE_MS,
  type OriginalEntry,
} from '../lib/originals.js';
import { getRecaptchaToken } from '../lib/recaptcha.js';
import { useSelection } from '../lib/selection.js';
import {
  combineReferences,
  visibleResults,
  scoreBand,
  displayConfidence,
  faceAlertFor,
  bulkVoteTargets,
  type FaceAlert,
} from '../lib/results.js';
import { analyzePhoto, type QualityResult, type QualityIssue } from '../lib/photoQuality.js';
import {
  suggestedPortraitRect,
  renderCropToFile,
  renderCropToDataUrl,
  imageSize,
  type CropRect,
  type NormBox,
} from '../lib/faceCrop.js';
import { CropEditor } from '../components/CropEditor.js';
import { savePhotosIndividually, type NamedBlob } from '../lib/downloads.js';
import { canShareImageFiles } from '../lib/share.js';
import { downloadOriginalsZip } from '../lib/zipDownload.js';
import { reportClientError } from '../lib/reportError.js';
import { type ShareOutcome } from '../lib/share.js';
import { saveResults, loadResults, clearResults } from '../lib/findmeCache.js';
import { useFindMePageSize, FINDME_PAGE_SIZE_OPTIONS } from '../lib/pageSize.js';
import { getStoredName, setStoredName } from '../lib/userName.js';
import { SelectBar } from '../components/SelectBar.js';
import { Lightbox } from '../components/Lightbox.js';
import { PageSizeSelect } from '../components/PageSizeSelect.js';
import { Pager } from '../components/Pager.js';
import { useStrings } from '../lib/i18n.js';

const STR = {
  en: {
    enterNameHint: 'Enter your name to continue.',
    tickConsentHint: 'Tick the consent box to continue.',
    confirmGuardianHint: 'Confirm guardian consent to continue.',
    savedLabel: 'Saved',
    searchFailed: 'Search failed',
    outfitLabel: 'Outfit',
    photoLabel: 'Photo',
    anchoredLabel: 'Refined',
    checkingPhotoLabel: 'Checking your photo…',
    anchorTitle: 'Found a clearer photo of you',
    anchorBody:
      'This shot of you from the event is a better starting point than a selfie — it was taken by the same cameras, in the same light, in the clothes you wore. Searching again from it usually finds more.',
    anchorCta: 'Find more using this photo',
    anchorDismiss: 'No thanks',
    noUsableFace:
      'We couldn’t find a clear face in that photo. You can search by outfit and appearance instead, or try a sharper, front-facing picture.',
    eventNotIndexed:
      'This event hasn’t been indexed for Find Me yet — ask an admin to run indexing.',
    feedbackFailed: 'Could not record that feedback — please try again.',
    downloadFailed: 'Download failed',
    downloadSkipped: (failed: number) => ` (${failed} couldn't be loaded and were skipped)`,
    downloadedZip: (included: number, skipped: string) =>
      `Downloaded ${included} photo${included === 1 ? '' : 's'} as a ZIP.${skipped}`,
    photosCount: (count: number) => `${count} photo${count === 1 ? '' : 's'}`,
    sentToShare: (photos: string, skipped: string) =>
      `Sent ${photos} to your share sheet — choose Save to Photos.${skipped}`,
    downloadedPhotos: (photos: string, skipped: string) => `Downloaded ${photos}.${skipped}`,
    shareTitle: 'My event photos',
    couldNotSavePhotos: 'Could not save photos',
    couldNotLoadAny:
      'Could not load any of the selected photos. Please try again in a moment.',
    title: 'Find Me',
    backToGallery: '← Back to gallery',
    beforeWeSearch: 'Before we search',
    consentIntro:
      'Find Me compares a photo of you against this event’s photos using face matching. Your reference photo is used only for this search.',
    consentIntroZh:
      '人脸识别会将您的照片与本次活动的照片进行比对，您的参考照片仅用于本次搜索。',
    yourNameRequired: 'Your name (required)',
    namePlaceholder: 'e.g. Jamie Lee',
    nameHint: 'Required. Shown to event organizers so they know who searched.',
    searchingAs: (n: string): string => `Searching as ${n}.`,
    notYou: 'Not you? Enter a different name',
    consentPhoto:
      'I consent to the use of this photo for face matching in this event.',
    isMinor: 'The person in the photo is under 18.',
    guardianConsent:
      'I am the parent or legal guardian of this child and I consent to this search on their behalf.',
    continue: 'Continue',
    addAnotherPhoto: 'Add another photo',
    uploadYourself: 'Upload a photo of yourself',
    pickHint:
      'A clear, front-facing photo works best — a selfie is perfect. You can pick a few at once and we’ll combine them for better matches.',
    chooseTakePhoto: 'Choose / take photo(s)',
    photoQualityTitle: 'This photo may be hard to match',
    photoQualityIntro:
      'A clearer photo usually finds more of your pictures. We noticed:',
    qLowResolution:
      'It’s low-resolution — your face may be too small to match well.',
    qBlurry: 'It looks blurry.',
    qDark: 'It looks quite dark.',
    qBright: 'It looks overexposed (too bright).',
    // Server-side face check, run as soon as the photos are picked.
    qNoFace: 'We couldn’t find a clear face in it.',
    qBadImage: 'We couldn’t read that file.',
    qFaceTooSmall: 'Your face is too small in it to match reliably.',
    qLowConfidence: 'We’re not confident that’s a face.',
    qMultipleFaces:
      'There’s more than one face in it. We can’t tell which one is you, so please use a photo with only you in it.',
    qNotFrontal: 'Your face is turned away from the camera — a head-on photo matches better.',
    qFaceSmallInFrame: 'Your face is small in the frame — hold the camera closer.',
    qSlightlySoft: 'It’s a little soft — a sharper photo matches better.',
    searchAnyway: 'Search anyway',
    rejectedTitle: 'We can’t search with that photo',
    reframeTitle: 'We’ve zoomed in on you',
    reframeBody:
      'You were small in the original, so we cropped in. Check it’s you, adjust it, or pick another photo — we’ll search with the version shown here.',
    reframeAlt: 'The cropped version of your photo that will be used to search',
    cropUse: 'Looks good — search',
    cropAdjust: 'Adjust the crop',
    cropEditTitle: 'Adjust the crop',
    cropEditHint:
      'Drag inside the box to move it, or a corner to resize. Keep your head and upper body in frame — your clothing helps the match too.',
    cropRegionLabel: 'Crop area',
    chooseAnother: 'Choose a different photo',
    multiFaceTitle: 'More than one face detected',
    weakFaceTitle: 'This selfie may not match well',
    multiFaceBody: (count: number) =>
      `Your photo has ${count} faces in it, so we picked the clearest one and searched for that person.`,
    wSmallFace:
      'The face is small in the photo — hold the camera closer, or crop in so your face fills more of the frame.',
    wNotFrontal:
      'The face is turned away from the camera — look straight at the lens for the best match.',
    wSlightlySoft: 'The photo is a little soft — a sharper one matches more reliably.',
    multiFaceBoxHint: 'The outlined face is the one we matched.',
    multiFaceCheck:
      'If the matches below aren’t you, upload a photo with only you in it.',
    weakFaceCheck: 'A clearer photo usually finds more of your pictures.',
    multiFaceUseAnother: 'Upload a photo of just me',
    weakFaceUseAnother: 'Try a better photo',
    multiFaceDismiss: 'That’s me — carry on',
    weakFaceDismiss: 'Carry on',
    multiFaceSelfieAlt: 'The photo you uploaded, with the matched face outlined',
    // Specific "we couldn't use this photo" reasons (the 422). Shown instead of
    // the generic no-face line so the searcher knows what to change.
    noFaceTitle: 'We couldn’t use that photo',
    rNoFaceDetected: 'We couldn’t find a face in it at all.',
    rTooSmall: 'The face is too small — get closer, or crop in so your face fills the frame.',
    rTooBlurry: 'The photo is too blurry — hold still and try again in better light.',
    rLowConfidence:
      'We couldn’t make out a clear, front-facing face — look straight at the camera.',
    noFaceFallback: 'Try a sharper, front-facing photo where your face fills more of the frame.',
    orSearchOutfit: 'You can also search by outfit and appearance instead.',
    searchByOutfitInstead: 'Search by outfit instead',
    standardSearch: 'Standard search',
    standardSearchDesc:
      'uses your face — most accurate, but it needs a clear, front-facing photo.',
    searchByOutfit: 'Search by outfit',
    searchByOutfitDesc:
      'matches your clothing and overall appearance instead of your face — useful when no clear face is found, but only reliable within this event.',
    cancel: 'Cancel',
    reusePrevious: 'Or reuse a previous photo',
    reuseHint:
      'Pick one or more photos you uploaded before to match this event.',
    outfitMatch: 'Outfit match',
    faceMatch: 'Face match',
    previousUploadAlt: 'A photo you uploaded before',
    matchWithSelected: (count: number) => `Match this event with selected (${count})`,
    searchingTitle: 'Searching the event photos…',
    searchingHint: 'The first search can take a few seconds to warm up.',
    referencePhotos: 'Reference photos',
    combined: '★ Combined',
    yourReferenceAlt: 'Your reference photo',
    resultsForPhoto: 'Results for this photo',
    noMatchesCombined: 'No matches yet.',
    noMatchesSingle:
      'No matches for this photo (or you removed them all).',
    tryThe: 'Try the',
    fullGallery: 'full gallery',
    orAddAnother: 'or add another photo.',
    matchesCombined: (count: number) =>
      `${count} matches across your photos, best first.`,
    matchesSingle: (count: number) => `${count} possible matches, best first.`,
    tapToEnlarge:
      'Tap a photo to enlarge and check it’s you; tick the box to select, then download the originals.',
    matchesPerPage: 'Matches per page',
    showingRange: (rangeStart: number, rangeEnd: number, total: number) =>
      `Showing ${rangeStart}–${rangeEnd} of ${total}. “Select page” selects only this page — download one page at a time.`,
    selectPage: 'Select page',
    enlargePhoto: 'Enlarge photo',
    deselectPhoto: 'Deselect photo',
    selectPhoto: 'Select photo',
    notMe: 'Not me',
    bulkAsk: (n: number) =>
      `${n} more on this page — are they all you?`,
    bulkAllMe: 'All me',
    bulkAllNotMe: 'All not me',
    bulkAskSelected: (sel: number, rest: number) =>
      `You've ticked ${sel} on this page${rest > 0 ? ` and left ${rest} unticked` : ''}. Mark the ticked ones as you?`,
    bulkSelectedAreMe: (n: number) => `Yes — ${n} ${n === 1 ? 'photo' : 'photos'} of me`,
    bulkRestNotMe: (n: number) =>
      `The other ${n} on this page ${n === 1 ? "isn't" : "aren't"} me`,
    bulkDismiss: 'I’ll do them one by one',
    bulkRecorded: (n: number) => `Recorded ${n} ${n === 1 ? 'photo' : 'photos'}.`,
    meConfirmed: '✓ Me',
    thatsMe: "That's me",
    addAnotherPhotoBtn: '+ Add another photo',
    selectedLightbox: '✓ Selected',
    select: 'Select',
    bandStrong: 'Strong',
    bandPossible: 'Possible',
  },
  zh: {
    enterNameHint: '请填写姓名后继续。',
    tickConsentHint: '请勾选同意框后继续。',
    confirmGuardianHint: '请确认监护人同意后继续。',
    savedLabel: '已存',
    searchFailed: '搜索失败',
    outfitLabel: '服装',
    photoLabel: '照片',
    anchoredLabel: '优化',
    checkingPhotoLabel: '正在检查您的照片…',
    anchorTitle: '找到一张更清晰的您的照片',
    anchorBody:
      '这张活动现场的照片比自拍更适合作为参考——同样的相机、同样的光线、同样的衣着。用它再搜索一次通常能找到更多照片。',
    anchorCta: '用这张照片查找更多',
    anchorDismiss: '暂不需要',
    noUsableFace:
      '这张照片中没有找到清晰的人脸。您可以改用服装和外观搜索，或换一张更清晰的正面照片。',
    eventNotIndexed:
      '本次活动尚未建立人脸识别索引，请联系管理员运行索引。',
    feedbackFailed: '无法记录此反馈，请重试。',
    downloadFailed: '下载失败',
    downloadSkipped: (failed: number) => ` (${failed} 张无法加载，已跳过)`,
    downloadedZip: (included: number, skipped: string) =>
      `已将 ${included} 张照片打包为 ZIP 下载。${skipped}`,
    photosCount: (count: number) => `${count} 张照片`,
    sentToShare: (photos: string, skipped: string) =>
      `已将 ${photos} 发送到分享菜单，请选择「保存到照片」。${skipped}`,
    downloadedPhotos: (photos: string, skipped: string) => `已下载 ${photos}。${skipped}`,
    shareTitle: '我的活动照片',
    couldNotSavePhotos: '无法保存照片',
    couldNotLoadAny: '无法加载所选的任何照片，请稍后重试。',
    title: '人脸识别',
    backToGallery: '← 返回相册',
    beforeWeSearch: '搜索前须知',
    consentIntro:
      '人脸识别会将您的照片与本次活动的照片进行比对，您的参考照片仅用于本次搜索。',
    consentIntroZh:
      '人脸识别会将您的照片与本次活动的照片进行比对，您的参考照片仅用于本次搜索。',
    yourNameRequired: '您的姓名（必填）',
    namePlaceholder: '例如：张三',
    nameHint: '必填。此姓名会提供给活动主办方，以便了解是谁进行了搜索。',
    searchingAs: (n: string): string => `以 ${n} 的身份搜索。`,
    notYou: '不是您本人？输入其他姓名',
    consentPhoto: '我同意将此照片用于本次活动的人脸匹配。',
    isMinor: '照片中的人未满 18 岁。',
    guardianConsent: '我是该儿童的父母或法定监护人，并代表其同意本次搜索。',
    continue: '继续',
    addAnotherPhoto: '添加另一张照片',
    uploadYourself: '上传您的照片',
    pickHint: '清晰的正面照片效果最佳，自拍即可。可一次选择多张，我们会合并以提高匹配效果。',
    chooseTakePhoto: '选择或拍摄照片',
    photoQualityTitle: '这张照片可能不易匹配',
    photoQualityIntro: '更清晰的照片通常能找到更多您的照片。我们发现：',
    qLowResolution: '分辨率较低——您的面部可能太小，不易准确匹配。',
    qBlurry: '照片看起来有些模糊。',
    qDark: '照片看起来偏暗。',
    qBright: '照片看起来过曝（太亮）。',
    qNoFace: '未能在照片中找到清晰的人脸。',
    qBadImage: '无法读取该文件。',
    qFaceTooSmall: '照片中的面部太小，难以可靠匹配。',
    qLowConfidence: '不太确定这是一张人脸。',
    qMultipleFaces: '照片中有多张人脸。我们无法判断哪一张是您，请改用只有您本人的照片。',
    qNotFrontal: '面部偏离镜头——正面照片匹配效果更好。',
    qFaceSmallInFrame: '面部在画面中偏小——请把相机靠近一些。',
    qSlightlySoft: '照片略欠清晰——更锐利的照片匹配效果更好。',
    searchAnyway: '仍然搜索',
    rejectedTitle: '无法使用这张照片进行搜索',
    reframeTitle: '已为您放大画面',
    reframeBody:
      '原图中您占比较小，我们已裁剪。请确认是您本人，也可自行调整或换一张照片——搜索将使用此处显示的版本。',
    reframeAlt: '将用于搜索的裁剪后照片',
    cropUse: '就用这张搜索',
    cropAdjust: '调整裁剪',
    cropEditTitle: '调整裁剪范围',
    cropEditHint: '拖动方框可移动，拖动四角可缩放。请保留头部和上半身——衣着也有助于匹配。',
    cropRegionLabel: '裁剪区域',
    chooseAnother: '换一张照片',
    multiFaceTitle: '检测到多张人脸',
    weakFaceTitle: '这张自拍可能不易匹配',
    multiFaceBody: (count: number) =>
      `您的照片中有 ${count} 张人脸，我们选择了其中最清晰的一张进行搜索。`,
    wSmallFace: '照片中的人脸偏小——请靠近拍摄，或裁剪照片让面部占更大画面。',
    wNotFrontal: '照片中的人脸没有正对镜头——请直视镜头以获得最佳匹配效果。',
    wSlightlySoft: '照片略微模糊——更清晰的照片匹配更可靠。',
    multiFaceBoxHint: '方框标出的即为我们所匹配的人脸。',
    multiFaceCheck: '如果下面的结果不是您，请上传一张只有您本人的照片。',
    weakFaceCheck: '更清晰的照片通常能找到更多您的照片。',
    multiFaceUseAnother: '上传只有我的照片',
    weakFaceUseAnother: '换一张更好的照片',
    multiFaceDismiss: '就是我，继续',
    weakFaceDismiss: '继续',
    multiFaceSelfieAlt: '您上传的照片，方框标出所匹配的人脸',
    noFaceTitle: '无法使用这张照片',
    rNoFaceDetected: '照片中完全没有检测到人脸。',
    rTooSmall: '人脸太小——请靠近拍摄，或裁剪照片让面部占满画面。',
    rTooBlurry: '照片太模糊——请保持稳定，并在光线更好的环境下重拍。',
    rLowConfidence: '无法识别出清晰的正面人脸——请直视镜头。',
    noFaceFallback: '请换一张更清晰、面部占比更大的正面照片。',
    orSearchOutfit: '您也可以改用服装和外观搜索。',
    searchByOutfitInstead: '改用服装搜索',
    standardSearch: '标准搜索',
    standardSearchDesc: '使用人脸匹配，最准确，但需要清晰的正面照片。',
    searchByOutfit: '服装搜索',
    searchByOutfitDesc:
      '根据您的衣着和整体外观（而非面部）进行匹配，在找不到清晰人脸时很有用，但仅在本次活动内可靠。',
    cancel: '取消',
    reusePrevious: '或重复使用以前的照片',
    reuseHint: '选择一张或多张您之前上传的照片来匹配本次活动。',
    outfitMatch: '服装匹配',
    faceMatch: '人脸匹配',
    previousUploadAlt: '您之前上传的照片',
    matchWithSelected: (count: number) => `用所选照片匹配（${count}）`,
    searchingTitle: '正在搜索活动照片…',
    searchingHint: '首次搜索可能需要几秒钟来预热。',
    referencePhotos: '参考照片',
    combined: '★ 合并',
    yourReferenceAlt: '您的参考照片',
    resultsForPhoto: '此照片的匹配结果',
    noMatchesCombined: '暂无匹配结果。',
    noMatchesSingle: '此照片没有匹配结果（或已全部移除）。',
    tryThe: '可浏览',
    fullGallery: '完整相册',
    orAddAnother: '或添加另一张照片。',
    matchesCombined: (count: number) =>
      `您的照片共匹配到 ${count} 张，按相似度排序。`,
    matchesSingle: (count: number) => `共 ${count} 张可能匹配，按相似度排序。`,
    tapToEnlarge: '点按照片可放大确认是否是您；勾选方框选中后即可下载原图。',
    matchesPerPage: '每页匹配数',
    showingRange: (rangeStart: number, rangeEnd: number, total: number) =>
      `正在显示第 ${rangeStart}–${rangeEnd} 张，共 ${total} 张。"选择本页"仅选中本页——请逐页下载。`,
    selectPage: '选择本页',
    enlargePhoto: '放大照片',
    deselectPhoto: '取消选择照片',
    selectPhoto: '选择照片',
    notMe: '不是我',
    bulkAsk: (n: number) => `本页还有 ${n} 张——都是您吗？`,
    bulkAllMe: '全部是我',
    bulkAllNotMe: '全部不是我',
    bulkAskSelected: (sel: number, rest: number) =>
      `本页已勾选 ${sel} 张${rest > 0 ? `，未勾选 ${rest} 张` : ''}。将勾选的标注为您本人？`,
    bulkSelectedAreMe: (n: number) => `是，这 ${n} 张是我`,
    bulkRestNotMe: (n: number) => `本页其余 ${n} 张不是我`,
    bulkDismiss: '我逐张确认',
    bulkRecorded: (n: number) => `已记录 ${n} 张照片。`,
    meConfirmed: '✓ 是我',
    thatsMe: '是我',
    addAnotherPhotoBtn: '+ 添加另一张照片',
    selectedLightbox: '✓ 已选中',
    select: '选择',
    bandStrong: '高匹配',
    bandPossible: '可能匹配',
  },
};

type Phase = 'consent' | 'pick' | 'searching' | 'results';

/** Client-side cap on selfies per search; mirrors the api's MAX_REFERENCE_IMAGES. */
const MAX_REFERENCE_IMAGES = 5;


/** How a result set was queried, kept so an anchored re-search can repeat the
 *  same query with an event photo added — without asking for the selfie again. */
type Origin =
  | { kind: 'files'; files: File[]; mode: 'fused' | 'person' }
  | { kind: 'upload'; upload: ReferenceUpload };

/** One reference selfie and the result set it produced. Result sets are kept
 *  separate per reference (B3) — they only merge in the explicit Combined view. */
interface Reference {
  id: string;
  previewUrl: string;
  label: string;
  runId?: string;
  mode: string;
  results: MatchResult[];
  hidden: Set<string>; // photoIds removed via "not me" (B7)
  /** The matcher's nomination for a better reference than this selfie. */
  anchorSuggestion: AnchorSuggestion | null;
  /** Event photos this set was already anchored on (so we don't re-offer them). */
  anchoredWith: string[];
  /** Null for a set restored from the session cache: the picked `File`s can't be
   *  serialized, so an anchored re-search isn't possible after a reload. */
  origin: Origin | null;
}

const COMBINED = 'combined';

/** One thing the server-side selfie check found, ready to render. */
/**
 * A proposed reframe of a badly-framed pick. Held together because the editor
 * needs the same decode the preview came from: the object URL to draw, the
 * natural size to map screen coordinates onto, and the suggested rect to start
 * from. `objectUrl` is owned here and revoked by `clearReframe`.
 */
interface Reframe {
  file: File;
  objectUrl: string;
  width: number;
  height: number;
  rect: CropRect;
  /** Data URL of the suggested crop, shown before the editor is opened. */
  previewUrl: string;
}

interface Finding {
  code: string;
  label: string;
  /** Worth stopping the flow for, vs. just worth mentioning. */
  blocking: boolean;
}

/**
 * Findings that stop the flow outright — there is no "search anyway" past these.
 *
 * All of them come back as hard `reasons` from the check, meaning the server
 * already marked the photo unusable. `multiple_faces` is the one that is a
 * refusal rather than a failure: the photo is perfectly good, but with a
 * bystander in frame the searched-for face is chosen by detector confidence,
 * so an override would just be a coin flip dressed up as a choice.
 */
const BLOCKING_FINDINGS: ReadonlySet<string> = new Set([
  'no_face',
  'bad_image',
  'too_small',
  'too_blurry',
  'low_confidence',
  'multiple_faces',
]);

/**
 * Advisories worth a confirmation step rather than a silent pass. A face that is
 * small in frame is the case where the detector may have locked onto the wrong
 * person entirely, so we show the crop and ask — the photo is still searchable
 * either way. `not_frontal` and `slightly_soft` only degrade matching, so they
 * are mentioned alongside, never on their own.
 */
const CONFIRM_FINDINGS: ReadonlySet<string> = new Set(['face_small_in_frame']);

function withRemoved(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  next.delete(id);
  return next;
}

/**
 * Rejection reasons off a `no_usable_face` 422. Unknown codes are dropped
 * rather than rendered raw; an empty result means "no diagnostics", and the
 * caller falls back to the generic advice.
 */
function parseNoFaceReasons(err: ApiError): SelfieFaceReason[] {
  const raw = err.body.reasons;
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is SelfieFaceReason => SelfieFaceReasonSchema.safeParse(r).success);
}

/**
 * Find Me flow. Consent → selfie upload → per-selfie results, with a reference
 * picker to switch between uploads, an explicit deduped Combined view (B3),
 * multi-select original-resolution ZIP download (B1/B2), and "not me / that's
 * me" feedback that removes wrong matches optimistically (B7).
 */
export function FindMe(): JSX.Element {
  const t = useStrings(STR);
  const { eventId = '' } = useParams();
  const [phase, setPhase] = useState<Phase>('consent');
  const [agreed, setAgreed] = useState(false);
  // Required: Find Me is open to guests, so we capture who is searching (feeds
  // the admin alert). Captured once per session — at guest sign-in or here on
  // first use — then remembered, so we don't ask again on later events/pages.
  const [sessionName] = useState(() => getStoredName());
  const [name, setName] = useState(sessionName);
  // A remembered name saves the usual searcher from retyping, but the device may
  // have been handed to someone else (they're common at events) — so the name is
  // always changeable, and whoever is searching types their own.
  const [editingName, setEditingName] = useState(false);
  const haveSessionName = sessionName.length > 0 && !editingName;
  const [isMinor, setIsMinor] = useState(false);
  const [guardianOk, setGuardianOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When a reference set has no detectable face we hold the files here to offer
  // an outfit-only retry (FR-7) without making the user re-pick them.
  const [noFaceFiles, setNoFaceFiles] = useState<File[]>([]);
  // Why the matcher rejected them (too small / blurry / none found), so we can
  // say what to fix instead of a generic "no clear face". Empty when the api
  // reports no diagnostics — the generic line is then the fallback.
  const [noFaceReasons, setNoFaceReasons] = useState<SelfieFaceReason[]>([]);
  // Picked files whose client-side quality check flagged them as poor: we hold
  // them and show a warning so the user can pick clearer photos OR search anyway,
  // rather than silently running a search that can't match well.
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [photoQuality, setPhotoQuality] = useState<QualityResult | null>(null);
  // What the server-side face check found about the current picks (empty when
  // there is nothing to say, or when the check couldn't run).
  const [selfieFindings, setSelfieFindings] = useState<Finding[]>([]);
  // A refused pick: shown as a dead end with no way to search anyway.
  const [rejectedFindings, setRejectedFindings] = useState<Finding[]>([]);
  // The reframe we're proposing for a badly-framed pick, or null.
  const [reframe, setReframe] = useState<Reframe | null>(null);
  // True while the user is adjusting that crop by hand.
  const [editingCrop, setEditingCrop] = useState(false);
  const [checkingPhoto, setCheckingPhoto] = useState(false);
  // Reference-set ids whose anchor suggestion the user waved away, so it stays
  // dismissed while they keep browsing that set.
  const [dismissedAnchors, setDismissedAnchors] = useState<Set<string>>(new Set());
  const [references, setReferences] = useState<Reference[]>([]);
  // Raised when the last search's reference photo held more than one face.
  const [faceAlert, setFaceAlert] = useState<FaceAlert | null>(null);
  const [activeId, setActiveId] = useState<string>(COMBINED);
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  // Hides the bulk-verdict nudge until the page or reference changes.
  const [bulkDismissed, setBulkDismissed] = useState(false);
  // Opt-in: also mark this page's UNticked results as "not me". Off by default —
  // people download in batches, so an unticked photo usually means "not this
  // time", not "not me".
  const [restNotMe, setRestNotMe] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [saving, setSaving] = useState(false);
  // Save-to-Photos progress (C9): how many originals have been fetched so far.
  const [saveProgress, setSaveProgress] = useState<{ done: number; total: number } | null>(null);
  // Every byte read goes through one fetcher per event: it caches, joins
  // concurrent requests for the same photo and caps how many transfers run at
  // once, so the prefetch below, the save fallback and the ZIP cannot download
  // the same original more than once between them.
  //
  // iOS only honours navigator.share inside the tap's transient activation, so
  // we must NOT await a network fetch before sharing — the selection is
  // prefetched here and shared synchronously once it's cached.
  const originals = useRef<OriginalsFetcher | null>(null);
  if (!originals.current) originals.current = new OriginalsFetcher(eventId);
  // Mirrors the fetcher's cache into render state (blobs are shared, not copied).
  const [origBlobs, setOrigBlobs] = useState<Record<string, Blob>>({});
  // Selected ids whose original FAILED to load (e.g. a CORS/network error on the
  // signed-URL read). These count as "settled" so the Save button doesn't stay
  // disabled on "Preparing…" forever — tapping it then runs the fetch-then-share
  // fallback, which tolerates per-photo failures.
  const [prefetchFailed, setPrefetchFailed] = useState<Set<string>>(new Set());
  // Belt-and-suspenders: if a prefetch neither resolves nor rejects (a hung
  // request), stop showing "Preparing…" after this long so the button is usable.
  // Tapping then JOINS the transfers already running instead of starting a
  // duplicate set — the duplicate set is what used to saturate a phone's
  // connection and end in "could not load any of the selected photos".
  const [prepareTimedOut, setPrepareTimedOut] = useState(false);
  // Transient success line after a save/download (C9), announced via aria-live.
  const [status, setStatus] = useState<string | null>(null);

  /** Mirror one settled original into render state. Shared by the prefetch, the
   *  save fallback and the ZIP so all three report progress identically. */
  const recordSettled = useCallback((photoId: string, entry: OriginalEntry | null): void => {
    if (entry) {
      setOrigBlobs((prev) =>
        prev[photoId] === entry.blob ? prev : { ...prev, [photoId]: entry.blob },
      );
      setPrefetchFailed((prev) => {
        if (!prev.has(photoId)) return prev;
        const next = new Set(prev);
        next.delete(photoId);
        return next;
      });
      return;
    }
    setPrefetchFailed((prev) => (prev.has(photoId) ? prev : new Set(prev).add(photoId)));
  }, []);
  // Index into `visible` of the photo open in the lightbox, or null (C4/C5).
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  // Past reference selfies the user can reuse to search this event (D7/FR-10b).
  const [pastUploads, setPastUploads] = useState<ReferenceUpload[] | null>(null);
  const [selectedPast, setSelectedPast] = useState<Set<string>>(new Set());
  const fileInput = useRef<HTMLInputElement>(null);
  // Set once we've attempted to restore cached results, so the save effect
  // doesn't overwrite the cache before the restore has run (C6).
  const restored = useRef(false);

  // A non-empty name is required, alongside consent. Consent can't be given for
  // a minor without guardian attestation (PRD §8.3).
  const nameOk = name.trim().length > 0;
  const consentOk = agreed && nameOk && (!isMinor || guardianOk);
  // Tells the user exactly why "Continue" is disabled (the first unmet
  // requirement), so a greyed-out button is never unexplained.
  const consentHint = !nameOk
    ? t.enterNameHint
    : !agreed
      ? t.tickConsentHint
      : isMinor && !guardianOk
        ? t.confirmGuardianHint
        : null;
  // Real file-share capability (not just `navigator.share`, which can exist
  // without file support). When false we still offer a non-ZIP "Save photos"
  // fallback so a phone is never left with only the ZIP download.
  const canSavePhotos = canShareImageFiles();

  const activeRef = references.find((r) => r.id === activeId);
  const isCombined = activeId === COMBINED || !activeRef;

  const visible = useMemo<MatchResult[]>(() => {
    if (references.length === 0) return [];
    if (isCombined) return combineReferences(references);
    return activeRef ? visibleResults(activeRef) : [];
  }, [references, isCombined, activeRef]);

  // Matcher results come back as one ranked list (no server cursor), so we page
  // the *display* client-side into discrete numbered pages. "Select all" acts on
  // the CURRENT page only (pageIds), so each download is one batch that stays
  // within MAX_DOWNLOAD_PHOTOS — someone in hundreds of photos grabs them page
  // by page. Find Me's page sizes are capped at that download limit.
  const { pageSize, setPageSize } = useFindMePageSize();
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const shown = useMemo(
    () => visible.slice(page * pageSize, page * pageSize + pageSize),
    [visible, page, pageSize],
  );
  // Results on this page the user hasn't judged yet. "Judged" means confirmed
  // OR hidden by a "not me" — but a hidden result has already left `visible`,
  // so in practice this is the shown set minus the confirmed ones.
  const unvotedOnPage = useMemo(
    () => shown.filter((r) => !confirmed.has(r.photoId)).map((r) => r.photoId),
    [shown, confirmed],
  );
  const votedOnPage = shown.length - unvotedOnPage.length;
  // Offer the bulk verdict once they've judged a few and there is a worthwhile
  // remainder — not before (nothing to generalize from) and not after (nothing
  // left to apply it to). Per-reference only: feedback is attached to a runId,
  // and the Combined view has no single run behind it.

  const rangeStart = visible.length === 0 ? 0 : page * pageSize + 1;
  const rangeEnd = Math.min(visible.length, (page + 1) * pageSize);

  // Selection is scoped to the visible page: selecting "all" never exceeds one
  // downloadable batch, and switching page starts a fresh selection.
  const pageIds = useMemo(() => shown.map((r) => r.photoId), [shown]);
  const sel = useSelection(pageIds);

  // Stable key for the selected set so prefetch/prune effects only re-run when
  // the set changes, not every render.
  const selectedKey = useMemo(() => [...sel.selected].sort().join(','), [sel.selected]);
  // Ticked for download AND not yet judged — the photos a selection-driven
  // verdict would label.
  const selectedUnvotedCount = useMemo(
    () => unvotedOnPage.filter((id) => sel.isSelected(id)).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [unvotedOnPage, selectedKey],
  );

  const showBulkPrompt =
    !isCombined &&
    Boolean(activeRef) &&
    !bulkDismissed &&
    unvotedOnPage.length > 0 &&
    // Either they've judged a few (so there's a pattern to generalize) or
    // they've ticked some for download (a judgement in its own right).
    (votedOnPage > 0 || selectedUnvotedCount > 0);

  // All selected originals cached → the batch share can fire synchronously.
  const selectedReady = sel.count > 0 && [...sel.selected].every((id) => Boolean(origBlobs[id]));
  // Every selected original has SETTLED — cached, or its prefetch failed. Once
  // settled we stop blocking the Save button (a failed prefetch must not pin it
  // on "Preparing…" forever; the tap then takes saveSelected's fetch-then-share
  // fallback path). Distinct from `selectedReady`, which gates the fast
  // synchronous share and requires every blob actually cached.
  const selectedSettled =
    sel.count > 0 &&
    [...sel.selected].every((id) => Boolean(origBlobs[id]) || prefetchFailed.has(id));
  // On mobile, true while we're still prefetching selected originals (the Save
  // button shows "Preparing…" and stays disabled until they're all in hand). It
  // clears once everything settles or the prepare watchdog times out, so the
  // button can never stay permanently disabled. Selections past the prefetch cap
  // are never blocked on preparing — nothing is being prefetched for them.
  const savePreparing =
    canSavePhotos &&
    sel.count > 0 &&
    sel.count <= PREFETCH_MAX_PHOTOS &&
    !selectedSettled &&
    !prepareTimedOut;
  const preparedCount = useMemo(
    () => [...sel.selected].filter((id) => Boolean(origBlobs[id])).length,
    [sel.selected, origBlobs],
  );

  // Reset to the first page when the page size changes or the user switches
  // reference tabs (a different result set should start from the top).
  useEffect(() => {
    setPage(0);
  }, [pageSize, activeId]);

  // A dismissal applies to the page it was made on; a new page is a new ask.
  useEffect(() => {
    setBulkDismissed(false);
    setRestNotMe(false);
  }, [page, activeId]);

  // Keep the page in range if the result set shrinks (e.g. "Not me" removals).
  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);

  // Clear the selection when switching reference tabs OR changing page —
  // selection is per-page (no cross-upload or cross-page blending), so each
  // download is one self-contained batch.
  useEffect(() => {
    sel.selectNone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, page]);

  // Load the user's reusable past selfies the first time they reach "pick".
  useEffect(() => {
    if (phase === 'pick') void loadPastUploads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // C6: restore cached results on mount so a reload (or the iOS share/download
  // bounce) doesn't wipe the matches and force a re-search. Runs once.
  useEffect(() => {
    const cached = loadResults(eventId);
    if (cached && cached.references.length > 0) {
      // A restored set has no query to re-run (see Reference.origin), so it also
      // carries no anchor suggestion — the button would have nothing to search with.
      setReferences(
        cached.references.map((r) => ({ ...r, anchorSuggestion: null, anchoredWith: [], origin: null })),
      );
      setActiveId(cached.activeId);
      setConfirmed(cached.confirmed);
      setPhase('results');
    }
    restored.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  // C6: persist whenever the result set changes (after the initial restore).
  // Clear the cache once everything is gone.
  useEffect(() => {
    if (!restored.current) return;
    if (references.length > 0) saveResults(eventId, { references, activeId, confirmed });
    else clearResults(eventId);
  }, [eventId, references, activeId, confirmed]);

  // Close the lightbox if its target scrolls out of the current page (e.g.
  // after "Not me" removes it, or switching reference tabs / pages). The
  // lightbox is scoped to the current page, so it indexes into `shown`.
  useEffect(() => {
    if (lightboxIndex !== null && lightboxIndex >= shown.length) {
      setLightboxIndex(shown.length > 0 ? shown.length - 1 : null);
    }
  }, [shown.length, lightboxIndex]);

  // Prefetch selected originals (mobile only) so the batch "Save to Photos" can
  // share synchronously inside the tap.
  //
  // Debounced, because ticking boxes one at a time would otherwise fire a
  // signing call per tick; and skipped entirely above PREFETCH_MAX_PHOTOS, since
  // buffering a whole 200-match page of full-resolution originals is hundreds of
  // megabytes the user never asked for — they may only want the ZIP. Above the
  // cap the Save button stays live and fetches on tap instead.
  useEffect(() => {
    const fetcher = originals.current;
    if (!canSavePhotos || !fetcher) return;
    const ids = [...sel.selected];
    if (ids.length === 0 || ids.length > PREFETCH_MAX_PHOTOS) return;
    const timer = setTimeout(() => {
      void fetcher.fetch(ids, { onSettled: recordSettled });
    }, PREFETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSavePhotos, selectedKey]);

  // Drop cached originals no longer selected (bounds mobile memory). Keyed on
  // the selected set so it runs when the selection shrinks or switches tabs.
  useEffect(() => {
    const fetcher = originals.current;
    if (!fetcher) return;
    if (fetcher.retain(sel.selected)) {
      setOrigBlobs((prev) => {
        const next: Record<string, Blob> = {};
        for (const id of Object.keys(prev)) if (sel.isSelected(id)) next[id] = prev[id]!;
        return Object.keys(next).length === Object.keys(prev).length ? prev : next;
      });
    }
    // Forget failures for ids no longer selected so a future re-select retries.
    setPrefetchFailed((prev) => {
      const next = new Set([...prev].filter((id) => sel.isSelected(id)));
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  // Cancel anything still transferring when the page unmounts.
  useEffect(() => () => originals.current?.abort(), []);

  // Prepare watchdog: if the prefetch hasn't settled within a few seconds (e.g.
  // a hung request that never resolves or rejects), stop showing "Preparing…"
  // so the Save button becomes tappable and falls back to fetch-then-share.
  // Reset whenever the selection changes or it does settle on its own.
  useEffect(() => {
    setPrepareTimedOut(false);
    if (!canSavePhotos || sel.count === 0 || selectedSettled) return;
    const t = setTimeout(() => setPrepareTimedOut(true), 12_000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSavePhotos, selectedKey, selectedSettled]);

  /** Append a result set from a search response and make it the active tab. */
  function pushReference(
    res: SearchResponse,
    previewUrl: string,
    labelPrefix: string,
    origin: Origin,
  ): void {
    const id = res.runId ?? crypto.randomUUID();
    // Warn if this selfie was a group shot. First one to trip it wins and is
    // never retracted here: reusing several stored selfies pushes one reference
    // per photo, and a clean second photo must not silently withdraw the
    // warning the first one earned. Callers clear it when a new search starts.
    const alert = faceAlertFor(res.referenceFaces, previewUrl);
    if (alert) setFaceAlert((prev) => prev ?? alert);
    setReferences((prev) => [
      ...prev,
      {
        id,
        previewUrl,
        label: `${labelPrefix} ${prev.length + 1}`,
        ...(res.runId !== undefined ? { runId: res.runId } : {}),
        mode: res.mode,
        results: res.results,
        hidden: new Set(),
        anchorSuggestion: res.anchorSuggestion ?? null,
        anchoredWith: res.anchorPhotoIds ?? [],
        origin,
      },
    ]);
    setActiveId(id);
  }

  async function loadPastUploads(force = false): Promise<void> {
    if (pastUploads !== null && !force) return;
    try {
      const res = await apiGet<ListReferencesResponse>('/api/findme/uploads');
      setPastUploads(res.uploads);
    } catch {
      // Non-fatal: if history can't load we just don't show the reuse section.
      setPastUploads([]);
    }
  }

  function togglePast(uploadId: string): void {
    setSelectedPast((prev) => {
      const next = new Set(prev);
      if (next.has(uploadId)) next.delete(uploadId);
      else next.add(uploadId);
      return next;
    });
  }

  async function searchByUpload(u: ReferenceUpload, anchorPhotoIds: string[] = []): Promise<void> {
    const body: SearchByUploadRequest = {
      eventId,
      name: name.trim(),
      ...(u.mode === 'person' ? { mode: 'person' as const } : {}),
      subjectIsMinor: isMinor,
      guardianAttested: guardianOk,
      ...(anchorPhotoIds.length ? { anchorPhotoId: anchorPhotoIds.join(',') } : {}),
    };
    const recaptchaToken = await getRecaptchaToken('findme_search');
    const res = await apiPost<SearchResponse, SearchByUploadRequest>(
      `/api/findme/uploads/${encodeURIComponent(u.uploadId)}/search`,
      body,
      recaptchaToken ? { headers: { 'X-Recaptcha-Token': recaptchaToken } } : undefined,
    );
    pushReference(res, u.url, anchorPhotoIds.length ? t.anchoredLabel : t.savedLabel, {
      kind: 'upload',
      upload: u,
    });
  }

  async function runSelectedPast(): Promise<void> {
    const chosen = (pastUploads ?? []).filter((u) => selectedPast.has(u.uploadId));
    if (chosen.length === 0) return;
    setPhase('searching');
    setError(null);
    setFaceAlert(null);
    try {
      // Sequential: each stored photo produces its own result set (FR-9), and
      // serial calls keep us under the per-user search rate limit.
      for (const u of chosen) {
        // eslint-disable-next-line no-await-in-loop
        await searchByUpload(u);
      }
      setSelectedPast(new Set());
      setPhase('results');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'guardian_required') setPhase('consent');
      else setPhase('pick');
      setError(e instanceof Error ? e.message : t.searchFailed);
    }
  }

  /** Localized "why we couldn't use your photo" line (the 422 reasons). */
  function noFaceReasonLabel(reason: SelfieFaceReason): string {
    switch (reason) {
      case 'no_face_detected':
        return t.rNoFaceDetected;
      case 'too_small':
        return t.rTooSmall;
      case 'too_blurry':
        return t.rTooBlurry;
      case 'low_confidence':
        return t.rLowConfidence;
    }
  }

  /** Localized advisory line for a face we DID use but that is weak. */
  function faceWarningLabel(warning: SelfieFaceWarning): string {
    switch (warning) {
      case 'face_small_in_frame':
        return t.wSmallFace;
      case 'not_frontal':
        return t.wNotFrontal;
      case 'slightly_soft':
        return t.wSlightlySoft;
    }
  }

  /** Localized explanation for one detected quality issue. */
  function qualityIssueLabel(issue: QualityIssue): string {
    switch (issue) {
      case 'low_resolution':
        return t.qLowResolution;
      case 'blurry':
        return t.qBlurry;
      case 'dark':
        return t.qDark;
      case 'bright':
        return t.qBright;
    }
  }

  /**
   * Quick client-side quality check on a freshly picked file. If it's clearly
   * poor (low-res / blurry), hold it and warn so the user can pick a clearer
   * photo or search anyway; otherwise go straight to search. The check failing
   * for any reason must never block the search — we just proceed.
   */
  async function handlePicked(files: File[]): Promise<void> {
    setError(null);
    setNoFaceFiles([]);
    setNoFaceReasons([]);
    setPendingFiles([]);
    setPhotoQuality(null);
    setSelfieFindings([]);
    clearReframe();
    setRejectedFindings([]);
    if (files.length === 0) return;
    setCheckingPhoto(true);
    // Multiple selfies are averaged into one centroid query (§1.1). We quality-
    // check them all and only warn if EVERY one is poor — a single sharp shot in
    // the set is enough to search well.
    let worst: QualityResult | null = null;
    let anyOk = false;
    for (const file of files) {
      let q: QualityResult | null = null;
      try {
        // eslint-disable-next-line no-await-in-loop
        q = await analyzePhoto(file);
      } catch {
        q = null;
      }
      if (!q || q.level !== 'poor') anyOk = true;
      if (q && q.level === 'poor') worst = q;
    }
    if (!anyOk && worst) {
      setCheckingPhoto(false);
      setPendingFiles(files);
      setPhotoQuality(worst);
      return;
    }

    // Server-side face check, at PICK time. The local check above measures the
    // whole image; only the detector can say "that's not a face", "you're turned
    // away" or "there are two people in frame" — the last of which used to
    // surface as a search that quietly found somebody else's photos.
    const check = await runSelfieCheck(files);
    setCheckingPhoto(false);
    if (!check) {
      void search(files); // check unavailable → never block the search
      return;
    }
    // Lead with the best pick: the FIRST file is the one persisted for reuse, so
    // the order decides which selfie the user gets offered again later.
    const ordered = orderByBest(files, check.bestIndex);
    const findings = selfieFindingLabels(check);
    if (!check.anyUsable || findings.some((f) => f.blocking)) {
      // Rejected. `rejected` (rather than pendingFiles) is what removes the
      // "search anyway" escape: there is no held-back file set to search with.
      setRejectedFindings(findings);
      // Every pick failed for want of a face. A search would 422, but an
      // outfit-only search can still work — offer it now rather than after a
      // wasted round trip.
      if (check.files.every((f) => f.reasons.includes('no_face'))) setNoFaceFiles(ordered);
      return;
    }
    // Usable, but badly framed — the face is small enough that the detector
    // could have locked onto someone behind them, and a distant subject matches
    // worse. Propose a reframe, which becomes the photo we upload.
    const best = check.files.find((f) => f.index === check.bestIndex) ?? check.files[0];
    const needsReframe = (best?.advisories ?? []).some((a) => CONFIRM_FINDINGS.has(a));
    if (needsReframe && best?.faceBox) {
      const proposal = await proposeReframe(ordered[0]!, best.faceBox);
      // A crop we couldn't draw would leave the prompt with nothing to look at,
      // which is worse than not asking — fall through and search the original.
      if (proposal) {
        setPendingFiles(ordered);
        setSelfieFindings(findings);
        setReframe(proposal);
        return;
      }
    }
    void search(ordered);
  }

  /**
   * Measure the picked photo and work out the crop we'd suggest. Everything the
   * reframe UI needs (and the editor after it) in one decode.
   */
  async function proposeReframe(file: File, faceBox: NormBox): Promise<Reframe | null> {
    const objectUrl = URL.createObjectURL(file);
    try {
      const size = await imageSize(objectUrl);
      if (!size) {
        URL.revokeObjectURL(objectUrl);
        return null;
      }
      const rect = suggestedPortraitRect(faceBox, size.width, size.height);
      const previewUrl = await renderCropToDataUrl(file, rect);
      if (!previewUrl) {
        URL.revokeObjectURL(objectUrl);
        return null;
      }
      return { file, objectUrl, ...size, rect, previewUrl };
    } catch {
      URL.revokeObjectURL(objectUrl);
      return null;
    }
  }

  /** Replace the leading pick with its cropped version and search.
   *
   *  Only the leading pick is reframed: it is the one the check graded and the
   *  one persisted for reuse, and silently recropping the others would apply a
   *  box computed from a different photo's face. */
  async function searchReframed(r: Reframe, rect: CropRect): Promise<void> {
    const cropped = await renderCropToFile(r.file, rect);
    const rest = pendingFiles.slice(1);
    const files = cropped ? [cropped, ...rest] : pendingFiles;
    dismissQualityWarning();
    void search(files);
  }

  /** POST the picks to the server check. Null = no verdict available (offline,
   *  matcher down, rate-limited): the caller proceeds to search regardless. */
  async function runSelfieCheck(files: File[]): Promise<SelfieCheckResponse | null> {
    const form = new FormData();
    for (const file of files) form.append('file', file);
    form.set('consent', 'true');
    try {
      return await apiUpload<SelfieCheckResponse>('/api/findme/selfie-check', form);
    } catch {
      return null;
    }
  }

  /** `bestIndex` first, the rest in their original order. */
  function orderByBest(files: File[], bestIndex: number | null): File[] {
    if (bestIndex === null || bestIndex <= 0 || bestIndex >= files.length) return files;
    const best = files[bestIndex]!;
    return [best, ...files.filter((_, i) => i !== bestIndex)];
  }

  /**
   * Turn a check into the lines we show. Hard `reasons` are collected across all
   * picks (any of them may be the unusable one); advisories come from the pick we
   * would actually lead with, since that is the one the search hinges on.
   * `blocking` marks the ones worth interrupting for — a photo that is merely a
   * bit soft is not worth a dialog, but a second face in frame is.
   */
  function selfieFindingLabels(check: SelfieCheckResponse): Finding[] {
    const codes = new Set<string>();
    for (const f of check.files) for (const r of f.reasons) codes.add(r);
    const best = check.files.find((f) => f.index === check.bestIndex) ?? check.files[0];
    for (const a of best?.advisories ?? []) codes.add(a);
    return [...codes]
      .map((code) => ({ code, label: selfieFindingLabel(code), blocking: BLOCKING_FINDINGS.has(code) }))
      .filter((f) => f.label !== null) as Finding[];
  }

  function selfieFindingLabel(code: string): string | null {
    switch (code) {
      case 'no_face':
        return t.qNoFace;
      case 'bad_image':
        return t.qBadImage;
      case 'too_small':
        return t.qFaceTooSmall;
      case 'too_blurry':
        return t.qBlurry;
      case 'low_confidence':
        return t.qLowConfidence;
      case 'multiple_faces':
        return t.qMultipleFaces;
      case 'not_frontal':
        return t.qNotFrontal;
      case 'face_small_in_frame':
        return t.qFaceSmallInFrame;
      case 'slightly_soft':
        return t.qSlightlySoft;
      default:
        return null; // a code this build doesn't know about — say nothing
    }
  }

  /** Drop the proposal and release the object URL it owns. */
  function clearReframe(): void {
    setReframe((prev) => {
      if (prev) URL.revokeObjectURL(prev.objectUrl);
      return null;
    });
    setEditingCrop(false);
  }

  function dismissQualityWarning(): void {
    setPendingFiles([]);
    setPhotoQuality(null);
    setSelfieFindings([]);
    clearReframe();
    setRejectedFindings([]);
  }

  /**
   * Re-run the query that produced `ref`, with one of its own results folded in
   * as an anchor. The photo is a stronger reference than the selfie on both
   * halves of the query: an in-domain face (same camera, light and distance) and
   * the outfit actually worn at the event.
   */
  async function searchWithAnchor(ref: Reference, photoId: string): Promise<void> {
    if (!ref.origin) return;
    if (ref.origin.kind === 'files') {
      await search(ref.origin.files, ref.origin.mode, [photoId]);
      return;
    }
    setPhase('searching');
    setError(null);
    try {
      await searchByUpload(ref.origin.upload, [photoId]);
      setPhase('results');
    } catch (e) {
      setError(e instanceof Error ? e.message : t.searchFailed);
      // Back to the results we already have rather than to the picker: the
      // failed call was a refinement, not the first search.
      setPhase('results');
    }
  }

  async function search(
    files: File[],
    mode: 'fused' | 'person' = 'fused',
    anchorPhotoIds: string[] = [],
  ): Promise<void> {
    if (files.length === 0) return;
    setPhase('searching');
    setError(null);
    setNoFaceFiles([]);
    setNoFaceReasons([]);
    setPendingFiles([]);
    setPhotoQuality(null);
    setSelfieFindings([]);
    clearReframe();
    setRejectedFindings([]);
    setFaceAlert(null);
    const form = new FormData();
    for (const file of files) form.append('file', file);
    form.set('eventId', eventId);
    form.set('name', name.trim());
    form.set('consent', 'true');
    form.set('subjectIsMinor', String(isMinor));
    form.set('guardianAttested', String(guardianOk));
    if (mode === 'person') form.set('mode', 'person');
    if (anchorPhotoIds.length) form.set('anchorPhotoId', anchorPhotoIds.join(','));
    try {
      const recaptchaToken = await getRecaptchaToken('findme_search');
      const res = await apiUpload<SearchResponse>(
        '/api/findme/search',
        form,
        recaptchaToken ? { headers: { 'X-Recaptcha-Token': recaptchaToken } } : undefined,
      );
      // Preview the first selfie — it's the one persisted for reuse.
      const labelPrefix = anchorPhotoIds.length
        ? t.anchoredLabel
        : mode === 'person'
          ? t.outfitLabel
          : t.photoLabel;
      pushReference(res, URL.createObjectURL(files[0]!), labelPrefix, {
        kind: 'files',
        files,
        mode,
      });
      setPhase('results');
      // Refresh history so this just-uploaded photo appears in the reuse picker.
      void loadPastUploads(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'no_usable_face') {
        // FR-7: keep the files and offer an outfit/appearance-only retry, and
        // say exactly what was wrong with the photo (the reasons block renders
        // in place of the generic error line).
        setNoFaceFiles(files);
        setNoFaceReasons(parseNoFaceReasons(e));
        setPhase('pick');
      } else if (e instanceof ApiError && e.code === 'guardian_required') {
        setError(e.message);
        setPhase('consent');
      } else if (e instanceof ApiError && e.code === 'event_not_indexed') {
        setError(t.eventNotIndexed);
        setPhase('pick');
      } else if (e instanceof ApiError && e.code === 'rate_limited') {
        setError(e.message);
        setPhase('pick');
      } else {
        setError(e instanceof Error ? e.message : t.searchFailed);
        setPhase('pick');
      }
    }
  }

  async function sendFeedback(
    photoId: string,
    verdict: 'not_me' | 'confirmed',
    runId?: string,
  ): Promise<void> {
    const body: FeedbackRequest = {
      eventId,
      photoId,
      verdict,
      ...(runId !== undefined ? { runId } : {}),
    };
    await apiPost('/api/feedback', body);
  }

  function handleNotMe(ref: Reference, photoId: string): void {
    // Optimistic removal (B7): hide immediately, drop from selection, then post.
    setReferences((prev) =>
      prev.map((r) => (r.id === ref.id ? { ...r, hidden: new Set(r.hidden).add(photoId) } : r)),
    );
    if (sel.isSelected(photoId)) sel.toggle(photoId);
    sendFeedback(photoId, 'not_me', ref.runId).catch(() => {
      // Revert on failure so the UI doesn't silently lose a real match.
      setReferences((prev) =>
        prev.map((r) => (r.id === ref.id ? { ...r, hidden: withRemoved(r.hidden, photoId) } : r)),
      );
      setError(t.feedbackFailed);
    });
  }

  function handleConfirm(ref: Reference, photoId: string): void {
    setConfirmed((prev) => new Set(prev).add(photoId));
    void sendFeedback(photoId, 'confirmed', ref.runId).catch(() => undefined);
  }

  /**
   * Record one verdict over several photos: optimistic first, reverted if the
   * write fails — the same contract as the single-vote handlers, which is why
   * nothing downstream can tell a bulk vote from the clicks it replaces.
   */
  function submitVotes(
    ref: Reference,
    ids: string[],
    verdict: 'not_me' | 'confirmed',
  ): Promise<number> {
    if (ids.length === 0) return Promise.resolve(0);

    if (verdict === 'confirmed') {
      setConfirmed((prev) => new Set([...prev, ...ids]));
    } else {
      setReferences((prev) =>
        prev.map((r) => (r.id === ref.id ? { ...r, hidden: new Set([...r.hidden, ...ids]) } : r)),
      );
      for (const id of ids) if (sel.isSelected(id)) sel.toggle(id);
    }

    const body: FeedbackBatchRequest = {
      eventId,
      photoIds: ids,
      verdict,
      ...(ref.runId !== undefined ? { runId: ref.runId } : {}),
    };
    return apiPost<FeedbackBatchResponse, FeedbackBatchRequest>('/api/feedback/batch', body)
      .then(() => ids.length)
      .catch((e: unknown) => {
        // Put them back rather than silently losing real matches — the same
        // reasoning as the single "not me" revert.
        if (verdict === 'confirmed') {
          setConfirmed((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
        } else {
          setReferences((prev) =>
            prev.map((r) =>
              r.id === ref.id
                ? { ...r, hidden: new Set([...r.hidden].filter((id) => !ids.includes(id))) }
                : r,
            ),
          );
        }
        throw e;
      });
  }

  /**
   * Apply one verdict to every result on this page the user hasn't judged yet.
   *
   * Scoped to `shown` — the current page — never the whole result set. Someone
   * with 800 matches should not be able to label 800 photos from a screen
   * showing 50 of them; they judge a page, page on, judge the next. That also
   * keeps the request inside MAX_FEEDBACK_BATCH by construction.
   */
  function handleBulkVote(ref: Reference, verdict: 'not_me' | 'confirmed'): void {
    runBulk(submitVotes(ref, unvotedOnPage, verdict));
  }

  /**
   * Label from the download selection instead of a blanket verdict.
   *
   * A blanket "all me" over a big page is where wrong labels come from; the
   * ticks are already a careful judgement the user made photo by photo, so
   * reusing them is strictly better evidence. What the UNTICKED ones mean is
   * genuinely ambiguous — "not me", or "me but blurry and I don't want it" —
   * so that is the user's call, not an inference:
   *
   *   'selected-only'  ticked → me. Unticked left unlabelled.
   *   'rest-not-me'    ticked → me, unticked → not me.
   */
  function handleSelectionVote(ref: Reference, mode: 'selected-only' | 'rest-not-me'): void {
    const { selected: selectedIds, rest: restIds } = bulkVoteTargets(
      pageIds,
      confirmed,
      sel.isSelected,
    );
    const work =
      mode === 'selected-only'
        ? submitVotes(ref, selectedIds, 'confirmed')
        : // Sequential: the "not me" pass hides its photos, and letting that
          // race the confirm pass would reorder the page under the user.
          submitVotes(ref, selectedIds, 'confirmed').then(async (n) =>
            n + (await submitVotes(ref, restIds, 'not_me')),
          );
    runBulk(work);
  }

  /** Shared bookkeeping around any bulk verdict. */
  function runBulk(work: Promise<number>): void {
    setBulkDismissed(true);
    setError(null);
    work
      .then((n) => setStatus(t.bulkRecorded(n)))
      .catch(() => setError(t.feedbackFailed));
  }

  async function downloadSelected(): Promise<void> {
    const fetcher = originals.current;
    if (sel.count === 0 || !fetcher) return;
    const ids = [...sel.selected];
    setDownloading(true);
    setError(null);
    setStatus(null);
    setSaveProgress({ done: fetcher.countCached(ids), total: ids.length });
    try {
      // Same fetcher as the save prefetch, so anything already in hand is zipped
      // from cache instead of pulled down a second time.
      const { included, failed } = await downloadOriginalsZip(
        fetcher,
        eventId,
        ids,
        'my-photos.zip',
        { onProgress: (done, total) => setSaveProgress({ done, total }) },
      );
      const skipped = failed > 0 ? t.downloadSkipped(failed) : '';
      setStatus(t.downloadedZip(included, skipped));
    } catch (e) {
      setError(e instanceof Error ? e.message : t.downloadFailed);
    } finally {
      setDownloading(false);
      setSaveProgress(null);
    }
  }

  function reportSave(outcome: ShareOutcome, count: number, failed = 0): void {
    const photos = t.photosCount(count);
    const skipped = failed > 0 ? t.downloadSkipped(failed) : '';
    // 'shared' → went to the share sheet (iOS "Save to Photos"); 'cancelled' →
    // user dismissed, say nothing; otherwise it fell back to file downloads.
    if (outcome === 'shared') {
      setStatus(t.sentToShare(photos, skipped));
    } else if (outcome !== 'cancelled') {
      setStatus(t.downloadedPhotos(photos, skipped));
    }
  }

  /**
   * "Save to Photos" (§5B C3). Hands the actual image FILES to the native share
   * sheet — on iOS that yields "Save N Images to Photos". A ZIP can't be expanded
   * into the iOS photo library, so we deliberately share images, not the ZIP.
   *
   * iOS only honours navigator.share while the tap's *transient activation* is
   * live, so we must NOT await a network fetch before calling it. On mobile the
   * selected originals are prefetched (the button stays disabled — "Preparing…"
   * — until they're all cached), so the fast path builds the files and shares
   * synchronously in the same tick. The fetch-then-share fallback runs on
   * desktop, for selections past the prefetch cap, and when the user taps while
   * transfers are still running — in that last case it JOINS them through the
   * shared fetcher rather than starting a second set, which is what used to
   * saturate a phone's connection and fail every photo.
   */
  function saveSelected(): void {
    const fetcher = originals.current;
    if (sel.count === 0 || !fetcher) return;
    const ids = [...sel.selected];
    const n = ids.length;
    setError(null);
    setStatus(null);

    // Fast path: every selected original is cached → share synchronously.
    if (canSavePhotos && selectedReady) {
      const files: NamedBlob[] = ids
        .map((id) => fetcher.get(id))
        .filter((e): e is OriginalEntry => e !== undefined)
        .map((e) => ({ blob: e.blob, filename: e.filename }));
      setSaving(true);
      savePhotosIndividually(files, { title: t.shareTitle })
        .then((outcome) => reportSave(outcome, files.length))
        .catch((e) => setError(e instanceof Error ? e.message : t.couldNotSavePhotos))
        .finally(() => setSaving(false));
      return;
    }

    void (async () => {
      setSaving(true);
      setSaveProgress({ done: fetcher.countCached(ids), total: n });
      try {
        let done = 0;
        const { entries, failed, sampleErrors } = await fetcher.fetch(ids, {
          onSettled: (photoId, entry) => {
            recordSettled(photoId, entry);
            done += 1;
            setSaveProgress({ done, total: n });
          },
        });

        if (entries.length === 0) {
          reportClientError('download_failed', 'Save to Photos: every original failed to load', {
            context: { eventId, requested: n, failed, sampleErrors },
          });
          setError(t.couldNotLoadAny);
          return;
        }
        reportSave(
          await savePhotosIndividually(
            entries.map((e) => ({ blob: e.blob, filename: e.filename })),
            { title: t.shareTitle },
          ),
          entries.length,
          failed,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : t.couldNotSavePhotos);
      } finally {
        setSaving(false);
        setSaveProgress(null);
      }
    })();
  }

  return (
    <div>
      <div className="gallery-header">
        <h2>{t.title}</h2>
        <Link to={`/events/${eventId}`} className="btn btn-light">
          {t.backToGallery}
        </Link>
      </div>

      {phase === 'consent' && (
        <div className="consent-card">
          <h3>{t.beforeWeSearch}</h3>
          <p>{t.consentIntro}</p>
          <p className="muted">{t.consentIntroZh}</p>
          {error && <p className="error-text">{error}</p>}
          {haveSessionName ? (
            // Name already captured this session (guest sign-in or a prior
            // event) — just confirm who's searching, don't ask again. The
            // "not you" escape matters on a shared phone: without it the next
            // person's search is attributed to whoever used it first.
            <p className="muted searching-as">
              {t.searchingAs(name)}{' '}
              <button
                type="button"
                className="btn-inline-link"
                onClick={() => {
                  setName('');
                  setEditingName(true);
                }}
              >
                {t.notYou}
              </button>
            </p>
          ) : (
            <label className="consent-row consent-name">
              <span>{t.yourNameRequired}</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t.namePlaceholder}
                maxLength={120}
                autoComplete="name"
                required
                aria-required="true"
              />
              <span className="field-hint muted">{t.nameHint}</span>
            </label>
          )}
          <label className="consent-row">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>{t.consentPhoto}</span>
          </label>
          <label className="consent-row">
            <input
              type="checkbox"
              checked={isMinor}
              onChange={(e) => {
                setIsMinor(e.target.checked);
                if (!e.target.checked) setGuardianOk(false);
              }}
            />
            <span>{t.isMinor}</span>
          </label>
          {isMinor && (
            <label className="consent-row consent-guardian">
              <input
                type="checkbox"
                checked={guardianOk}
                onChange={(e) => setGuardianOk(e.target.checked)}
              />
              <span>{t.guardianConsent}</span>
            </label>
          )}
          {!consentOk && consentHint && (
            <p className="field-hint muted" role="status">
              {consentHint}
            </p>
          )}
          <button
            className="btn btn-primary"
            disabled={!consentOk}
            onClick={() => {
              setError(null);
              // Remember the name for later events/pages so we don't re-ask.
              setStoredName(name);
              setPhase('pick');
            }}
          >
            {t.continue}
          </button>
        </div>
      )}

      {phase === 'pick' && (
        <div className="consent-card">
          <h3>{references.length > 0 ? t.addAnotherPhoto : t.uploadYourself}</h3>
          <p className="muted">{t.pickHint}</p>
          {error && <p className="error-text">{error}</p>}
          {/* The photo we just refused, and precisely why — a searcher told
              "no clear face" can't tell whether to move closer, hold still, or
              turn to face the camera. */}
          {noFaceFiles.length > 0 && (
            <div className="multiface-warn" role="alert">
              <div className="multiface-body">
                <p>
                  <strong>{t.noFaceTitle}</strong>
                </p>
                {noFaceReasons.length > 0 ? (
                  <ul>
                    {noFaceReasons.map((r) => (
                      <li key={r}>{noFaceReasonLabel(r)}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">{t.noFaceFallback}</p>
                )}
                <p className="muted">{t.orSearchOutfit}</p>
              </div>
            </div>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              // Several selfies of the same person → one centroid query (§1.1).
              const picked = Array.from(e.target.files ?? []).slice(0, MAX_REFERENCE_IMAGES);
              // Reset so re-picking the SAME file(s) still fires onChange.
              e.target.value = '';
              if (picked.length > 0) void handlePicked(picked);
            }}
          />
          {rejectedFindings.length > 0 ? (
            /* Refused. No "search anyway": every finding here means we cannot
               tell which face to search for, so an override would just pick one
               at random on the user's behalf. */
            <div className="photo-quality-warn" role="alert">
              <p>
                <strong>{t.rejectedTitle}</strong>
              </p>
              <ul>
                {rejectedFindings.map((f) => (
                  <li key={f.code}>{f.label}</li>
                ))}
              </ul>
              <div className="quality-actions">
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    dismissQualityWarning();
                    fileInput.current?.click();
                  }}
                >
                  {t.chooseAnother}
                </button>
              </div>
            </div>
          ) : reframe && editingCrop ? (
            <div className="photo-quality-warn">
              <CropEditor
                src={reframe.objectUrl}
                imgWidth={reframe.width}
                imgHeight={reframe.height}
                initial={reframe.rect}
                onCancel={() => setEditingCrop(false)}
                onConfirm={(rect) => void searchReframed(reframe, rect)}
                labels={{
                  title: t.cropEditTitle,
                  hint: t.cropEditHint,
                  confirm: t.cropUse,
                  cancel: t.cancel,
                  region: t.cropRegionLabel,
                }}
              />
            </div>
          ) : reframe ? (
            /* Badly framed. We propose a crop — head, shoulders and torso, so
               the outfit half of the query survives — and that crop is what
               gets uploaded if they accept it. */
            <div className="photo-quality-warn face-confirm" role="alert">
              <div className="face-confirm-body">
                <p>
                  <strong>{t.reframeTitle}</strong>
                </p>
                <p className="muted">{t.reframeBody}</p>
                <ul>
                  {selfieFindings.map((f) => (
                    <li key={f.code}>{f.label}</li>
                  ))}
                </ul>
                <div className="quality-actions">
                  <button
                    className="btn btn-primary"
                    onClick={() => void searchReframed(reframe, reframe.rect)}
                  >
                    {t.cropUse}
                  </button>
                  <button className="btn btn-light" onClick={() => setEditingCrop(true)}>
                    {t.cropAdjust}
                  </button>
                  <button
                    className="btn btn-light"
                    onClick={() => {
                      dismissQualityWarning();
                      fileInput.current?.click();
                    }}
                  >
                    {t.chooseAnother}
                  </button>
                </div>
              </div>
              <img className="face-crop" src={reframe.previewUrl} alt={t.reframeAlt} />
            </div>
          ) : (photoQuality || selfieFindings.length > 0) && pendingFiles.length > 0 ? (
            <div className="photo-quality-warn" role="alert">
              <p>
                <strong>{t.photoQualityTitle}</strong>
              </p>
              <p className="muted">{t.photoQualityIntro}</p>
              <ul>
                {/* Whole-image checks done in the browser, then what the face
                    detector found — one list, since to the user it's one verdict. */}
                {(photoQuality?.issues ?? []).map((i) => (
                  <li key={i}>{qualityIssueLabel(i)}</li>
                ))}
                {selfieFindings.map((f) => (
                  <li key={f.code}>{f.label}</li>
                ))}
              </ul>
              <div className="quality-actions">
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    const f = pendingFiles;
                    dismissQualityWarning();
                    void search(f);
                  }}
                >
                  {t.searchAnyway}
                </button>
                <button
                  className="btn btn-light"
                  onClick={() => {
                    dismissQualityWarning();
                    fileInput.current?.click();
                  }}
                >
                  {t.chooseAnother}
                </button>
              </div>
            </div>
          ) : (
            <button
              className="btn btn-primary"
              disabled={checkingPhoto}
              onClick={() => fileInput.current?.click()}
            >
              {checkingPhoto ? t.checkingPhotoLabel : t.chooseTakePhoto}
            </button>
          )}
          {noFaceFiles.length > 0 && (
            <button className="btn btn-light" onClick={() => void search(noFaceFiles, 'person')}>
              {t.searchByOutfitInstead}
            </button>
          )}
          {/* Standard (face) vs outfit search, so people understand the choice —
              especially after a "no clear face" fallback is offered. */}
          <div className="mode-note muted">
            <p>
              <strong>{t.standardSearch}</strong> {t.standardSearchDesc}
            </p>
            <p>
              <strong>{t.searchByOutfit}</strong> {t.searchByOutfitDesc}
            </p>
          </div>
          {references.length > 0 && (
            <button className="btn btn-light" onClick={() => setPhase('results')}>
              {t.cancel}
            </button>
          )}

          {pastUploads && pastUploads.length > 0 && (
            <div className="past-uploads">
              <h4>{t.reusePrevious}</h4>
              <p className="muted">{t.reuseHint}</p>
              <div className="past-grid">
                {pastUploads.map((u) => {
                  const checked = selectedPast.has(u.uploadId);
                  return (
                    <button
                      key={u.uploadId}
                      className={`past-cell${checked ? ' selected' : ''}`}
                      aria-pressed={checked}
                      onClick={() => togglePast(u.uploadId)}
                      title={u.mode === 'person' ? t.outfitMatch : t.faceMatch}
                    >
                      <img src={u.url} alt={t.previousUploadAlt} loading="lazy" />
                      <span className="select-tick">{checked ? '✓' : ''}</span>
                    </button>
                  );
                })}
              </div>
              <button
                className="btn btn-primary"
                disabled={selectedPast.size === 0}
                onClick={() => void runSelectedPast()}
              >
                {t.matchWithSelected(selectedPast.size)}
              </button>
            </div>
          )}
        </div>
      )}

      {phase === 'searching' && (
        <div className="searching" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <div>
            <p className="searching-title">{t.searchingTitle}</p>
            <p className="muted">{t.searchingHint}</p>
          </div>
        </div>
      )}

      {phase === 'results' && (
        <div>
          {references.length > 1 && (
            <div className="ref-picker" role="tablist" aria-label={t.referencePhotos}>
              {references.map((r) => (
                <button
                  key={r.id}
                  role="tab"
                  aria-selected={activeId === r.id}
                  className={`ref-tab${activeId === r.id ? ' active' : ''}`}
                  onClick={() => setActiveId(r.id)}
                  title={r.label}
                >
                  {r.previewUrl && <img src={r.previewUrl} alt={r.label} />}
                  <span>{r.label}</span>
                </button>
              ))}
              <button
                role="tab"
                aria-selected={isCombined}
                className={`ref-tab ref-combined${isCombined ? ' active' : ''}`}
                onClick={() => setActiveId(COMBINED)}
              >
                <span>{t.combined}</span>
              </button>
            </div>
          )}

          {references.length === 1 && activeRef && (
            <div className="ref-current">
              {activeRef.previewUrl && (
                <img src={activeRef.previewUrl} alt={t.yourReferenceAlt} />
              )}
              <span className="muted">{t.resultsForPhoto}</span>
            </div>
          )}

          {error && <p className="error-text">{error}</p>}
          {status && (
            <p className="status-text" role="status" aria-live="polite">
              {status}
            </p>
          )}

          {faceAlert && (
            // One block for everything worth saying about the selfie just
            // uploaded: a group shot, and/or a face that is small or turned
            // away. The multi-face case leads, since a wrong *identity* matters
            // more than a weak match.
            <div className="multiface-warn" role="alert">
              <div className="multiface-body">
                <p>
                  <strong>{faceAlert.count > 1 ? t.multiFaceTitle : t.weakFaceTitle}</strong>
                </p>
                {faceAlert.count > 1 && (
                  <p className="muted">
                    {t.multiFaceBody(faceAlert.count)}
                    {faceAlert.selectedFace ? ` ${t.multiFaceBoxHint}` : ''}
                  </p>
                )}
                {faceAlert.warnings.length > 0 && (
                  <ul>
                    {faceAlert.warnings.map((w) => (
                      <li key={w}>{faceWarningLabel(w)}</li>
                    ))}
                  </ul>
                )}
                <p className="muted">
                  {faceAlert.count > 1 ? t.multiFaceCheck : t.weakFaceCheck}
                </p>
                <div className="quality-actions">
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      setFaceAlert(null);
                      setPhase('pick');
                    }}
                  >
                    {faceAlert.count > 1 ? t.multiFaceUseAnother : t.weakFaceUseAnother}
                  </button>
                  <button className="btn btn-light" onClick={() => setFaceAlert(null)}>
                    {faceAlert.count > 1 ? t.multiFaceDismiss : t.weakFaceDismiss}
                  </button>
                </div>
              </div>
              {faceAlert.selectedFace && (
                // Percentage offsets over an unconstrained <img>, so the outline
                // lands on the face regardless of the photo's aspect ratio. The
                // box arrives normalized for exactly this reason.
                <div className="multiface-preview">
                  <img src={faceAlert.previewUrl} alt={t.multiFaceSelfieAlt} />
                  <span
                    className="face-box"
                    style={{
                      left: `${faceAlert.selectedFace[0] * 100}%`,
                      top: `${faceAlert.selectedFace[1] * 100}%`,
                      width: `${(faceAlert.selectedFace[2] - faceAlert.selectedFace[0]) * 100}%`,
                      height: `${(faceAlert.selectedFace[3] - faceAlert.selectedFace[1]) * 100}%`,
                    }}
                  />
                </div>
              )}
            </div>
          )}
          {/* Anchor promotion: offer the clearest photo of this person from the
              event as the reference for a follow-up search. Only on a single
              reference set (the Combined view has no one query to re-run), and
              only while its thumbnail is still on hand — the suggestion is always
              one of this set's own results, so no extra URL needs signing. */}
          {!isCombined && activeRef?.anchorSuggestion && !dismissedAnchors.has(activeRef.id)
            ? (() => {
                const s = activeRef.anchorSuggestion;
                const hit = activeRef.results.find((r) => r.photoId === s.photoId);
                if (!hit) return null;
                return (
                  <div className="anchor-suggest">
                    <img src={hit.thumbUrl} alt="" />
                    <div className="anchor-copy">
                      <p>
                        <strong>{t.anchorTitle}</strong>
                      </p>
                      <p className="muted">{t.anchorBody}</p>
                      <div className="quality-actions">
                        <button
                          className="btn btn-primary"
                          onClick={() => void searchWithAnchor(activeRef, s.photoId)}
                        >
                          {t.anchorCta}
                        </button>
                        <button
                          className="btn btn-light"
                          onClick={() =>
                            setDismissedAnchors((prev) => new Set(prev).add(activeRef.id))
                          }
                        >
                          {t.anchorDismiss}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })()
            : null}

          {visible.length === 0 ? (
            <p className="muted">
              {isCombined ? t.noMatchesCombined : t.noMatchesSingle}{' '}
              {t.tryThe}{' '}
              <Link to={`/events/${eventId}`}>{t.fullGallery}</Link> {t.orAddAnother}
            </p>
          ) : (
            <>
              <div className="results-toolbar">
                <p className="muted results-count">
                  {isCombined
                    ? t.matchesCombined(visible.length)
                    : t.matchesSingle(visible.length)}{' '}
                  {t.tapToEnlarge}
                </p>
                {visible.length > FINDME_PAGE_SIZE_OPTIONS[0] && (
                  <PageSizeSelect
                    value={pageSize}
                    onChange={setPageSize}
                    label={t.matchesPerPage}
                    options={FINDME_PAGE_SIZE_OPTIONS}
                  />
                )}
              </div>
              {pageCount > 1 && (
                <p className="muted batch-hint">
                  {t.showingRange(rangeStart, rangeEnd, visible.length)}
                </p>
              )}
              {showBulkPrompt && activeRef && (
                /* They've judged a few on this page; offer to finish the rest
                   in one go. Deliberately scoped to this page — see
                   handleBulkVote. */
                <div className="bulk-vote" role="status">
                  <span>
                    {selectedUnvotedCount > 0
                      ? t.bulkAskSelected(selectedUnvotedCount, unvotedOnPage.length - selectedUnvotedCount)
                      : t.bulkAsk(unvotedOnPage.length)}
                  </span>
                  <div className="bulk-vote-actions">
                    {selectedUnvotedCount > 0 ? (
                      /* Their ticks are a judgement they already made photo by
                         photo — better evidence than a blanket verdict.
                         Labelling the ticked ones is the whole action; the rest
                         is an opt-in, because people download in batches and a
                         half-finished selection says nothing about what's left. */
                      <>
                        {unvotedOnPage.length > selectedUnvotedCount && (
                          <label className="bulk-rest">
                            <input
                              type="checkbox"
                              checked={restNotMe}
                              onChange={(e) => setRestNotMe(e.target.checked)}
                            />
                            <span>{t.bulkRestNotMe(unvotedOnPage.length - selectedUnvotedCount)}</span>
                          </label>
                        )}
                        <button
                          className="btn btn-sm btn-primary"
                          onClick={() =>
                            handleSelectionVote(
                              activeRef,
                              restNotMe ? 'rest-not-me' : 'selected-only',
                            )
                          }
                        >
                          {t.bulkSelectedAreMe(selectedUnvotedCount)}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="btn btn-sm btn-light"
                          onClick={() => handleBulkVote(activeRef, 'confirmed')}
                        >
                          {t.bulkAllMe}
                        </button>
                        <button
                          className="btn btn-sm btn-light"
                          onClick={() => handleBulkVote(activeRef, 'not_me')}
                        >
                          {t.bulkAllNotMe}
                        </button>
                      </>
                    )}
                    <button
                      className="btn-inline-link"
                      onClick={() => setBulkDismissed(true)}
                    >
                      {t.bulkDismiss}
                    </button>
                  </div>
                </div>
              )}
              <SelectBar
                total={pageIds.length}
                selectedCount={sel.count}
                busy={downloading || saving}
                saveProgress={
                  savePreparing ? { done: preparedCount, total: sel.count } : saveProgress
                }
                savePreparing={savePreparing}
                canSave={canSavePhotos}
                selectAllLabel={t.selectPage}
                onSelectAll={sel.selectAll}
                onSelectNone={sel.selectNone}
                onInvert={sel.invert}
                onDownload={() => void downloadSelected()}
                onSaveToPhone={() => saveSelected()}
                {...(canSavePhotos ? {} : { onDownloadIndividual: () => saveSelected() })}
              />
              <div className="photo-grid">
                {shown.map((r, i) => {
                  const checked = sel.isSelected(r.photoId);
                  const band = scoreBand(r.score);
                  return (
                    <div key={r.photoId} className={`result-cell${checked ? ' selected' : ''}`}>
                      {/* C5: tapping the photo VIEWS it (lightbox); selection is
                          the separate checkbox so the two don't collide. */}
                      <button
                        className="result-thumb"
                        aria-label={t.enlargePhoto}
                        onClick={() => setLightboxIndex(i)}
                      >
                        <img src={r.thumbUrl} alt="" loading="lazy" />
                        {/* C7: confidence band (the raw % stays as detail). */}
                        <span className={`score-chip band-${band}`}>
                          {band === 'strong' ? t.bandStrong : t.bandPossible} ·{' '}
                          {displayConfidence(r.score)}%
                        </span>
                      </button>
                      <button
                        className="select-box"
                        aria-pressed={checked}
                        aria-label={checked ? t.deselectPhoto : t.selectPhoto}
                        onClick={() => sel.toggle(r.photoId)}
                      >
                        {checked ? '✓' : ''}
                      </button>
                      {!isCombined && activeRef && (
                        <div className="feedback-row">
                          <button
                            className="btn-feedback"
                            onClick={() => handleNotMe(activeRef, r.photoId)}
                          >
                            {t.notMe}
                          </button>
                          <button
                            className={`btn-feedback${confirmed.has(r.photoId) ? ' confirmed' : ''}`}
                            onClick={() => handleConfirm(activeRef, r.photoId)}
                          >
                            {confirmed.has(r.photoId) ? t.meConfirmed : t.thatsMe}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <Pager page={page} pageCount={pageCount} onChange={setPage} />
            </>
          )}

          <button className="btn btn-light" onClick={() => setPhase('pick')}>
            {t.addAnotherPhotoBtn}
          </button>

          {lightboxIndex !== null && shown[lightboxIndex] && (
            <Lightbox
              items={shown.map((r) => {
                const band = scoreBand(r.score);
                return {
                  key: r.photoId,
                  src: r.webUrl,
                  alt: '',
                  badge: (
                    <span className={`score-chip band-${band}`}>
                      {band === 'strong' ? t.bandStrong : t.bandPossible} ·{' '}
                      {displayConfidence(r.score)}%
                    </span>
                  ),
                };
              })}
              index={lightboxIndex}
              onClose={() => setLightboxIndex(null)}
              onNavigate={setLightboxIndex}
              renderFooter={(item) => {
                const checked = sel.isSelected(item.key);
                return (
                  <>
                    <button
                      className={`btn btn-sm ${checked ? 'btn-primary' : 'btn-light'}`}
                      onClick={() => sel.toggle(item.key)}
                    >
                      {checked ? t.selectedLightbox : t.select}
                    </button>
                    {!isCombined && activeRef && (
                      <>
                        <button
                          className="btn btn-light btn-sm"
                          onClick={() => handleNotMe(activeRef, item.key)}
                        >
                          {t.notMe}
                        </button>
                        <button
                          className={`btn btn-sm ${confirmed.has(item.key) ? 'btn-primary' : 'btn-light'}`}
                          onClick={() => handleConfirm(activeRef, item.key)}
                        >
                          {confirmed.has(item.key) ? t.meConfirmed : t.thatsMe}
                        </button>
                      </>
                    )}
                  </>
                );
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
