import vine from '@vinejs/vine'

export const loginValidator = vine.compile(
  vine.object({
    email: vine.string().trim().maxLength(254),
    password: vine.string().maxLength(1024),
  })
)

export const forgotPasswordValidator = vine.compile(
  vine.object({ email: vine.string().trim().maxLength(254) })
)

export const resetPasswordValidator = vine.compile(
  vine.object({
    token: vine.string().minLength(20).maxLength(200),
    newPassword: vine.string().maxLength(1024),
  })
)

export const verifyEmailValidator = vine.compile(
  vine.object({ token: vine.string().minLength(20).maxLength(200) })
)

export const changePasswordValidator = vine.compile(
  vine.object({
    currentPassword: vine.string().maxLength(1024),
    newPassword: vine.string().maxLength(1024),
  })
)
