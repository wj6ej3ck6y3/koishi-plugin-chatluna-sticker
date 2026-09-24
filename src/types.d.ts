import type { ChatLunaService } from 'koishi-plugin-chatluna'

declare module 'koishi' {
    interface Context {
        chatluna: ChatLunaService
    }
}