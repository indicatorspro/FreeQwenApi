export const FORGETMEAI_WATERMARK = 't.me/forgetmeai';

export function formatForgetMeAiWatermark(prefix = 'ForgetMeAI') {
    return `${prefix}: ${FORGETMEAI_WATERMARK}`;
}

export function printForgetMeAiWatermark() {
    console.log(`\n${formatForgetMeAiWatermark()}\n`);
}
