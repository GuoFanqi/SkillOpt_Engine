import * as tencentcloud from 'tencentcloud-sdk-nodejs-sms'

const SmsClient = tencentcloud.sms.v20210111.Client

interface SmsConfig {
  secretId: string
  secretKey: string
  sdkAppId: string
  signName: string
  templateId: string
}

function getConfig(): SmsConfig | null {
  const secretId = process.env.TENCENT_SMS_SECRET_ID
  const secretKey = process.env.TENCENT_SMS_SECRET_KEY
  const sdkAppId = process.env.TENCENT_SMS_SDK_APP_ID
  const signName = process.env.TENCENT_SMS_SIGN_NAME
  const templateId = process.env.TENCENT_SMS_TEMPLATE_ID

  if (secretId && secretKey && sdkAppId && signName && templateId) {
    return { secretId, secretKey, sdkAppId, signName, templateId }
  }
  return null
}

export async function sendVerificationCode(phone: string, code: string): Promise<boolean> {
  const cfg = getConfig()
  if (!cfg) {
    // 开发模式：打印到控制台
    console.log(`[SMS DEV] 验证码发送给 ${phone}: ${code}`)
    return false // false = dev mode, caller should show dev code
  }

  try {
    const client = new SmsClient({
      credential: {
        secretId: cfg.secretId,
        secretKey: cfg.secretKey,
      },
      region: 'ap-guangzhou',
      profile: { httpProfile: { endpoint: 'sms.tencentcloudapi.com' } },
    })

    await client.SendSms({
      PhoneNumberSet: [`+86${phone}`],
      SmsSdkAppId: cfg.sdkAppId,
      SignName: cfg.signName,
      TemplateId: cfg.templateId,
      TemplateParamSet: [code],
    })

    console.log(`[SMS] 验证码已发送给 ${phone}`)
    return true
  } catch (e: any) {
    console.error(`[SMS] 发送失败:`, e.message)
    throw new Error('短信发送失败，请稍后重试')
  }
}

export function isSmsConfigured(): boolean {
  return getConfig() !== null
}
