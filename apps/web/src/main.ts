import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './app/App.vue'
import { router } from './app/router'
import './design/tokens.css'
import './design/global.css'
import './design/settings.css'

createApp(App).use(createPinia()).use(router).mount('#app')
