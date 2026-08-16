declare module 'qrcode/lib/browser.js' {
  export function toDataURL(
    text: string,
    options?: {
      width?: number
      margin?: number
      errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
    },
  ): Promise<string>
}
