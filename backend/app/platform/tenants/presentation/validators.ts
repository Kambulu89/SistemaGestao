import vine from '@vinejs/vine'

export const vineAcceptValidator = vine.compile(
  vine.object({ token: vine.string().minLength(20).maxLength(300) })
)
