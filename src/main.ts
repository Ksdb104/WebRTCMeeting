import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import i18n from './i18n'
import './assets/main.css'

window.addEventListener('vite:preloadError', () => {
  const reloadKey = 'preload-error-reload'
  if (sessionStorage.getItem(reloadKey)) return

  sessionStorage.setItem(reloadKey, 'true')
  window.location.reload()
})

const app = createApp(App)

app.use(createPinia())
app.use(router)
app.use(i18n)

app.mount('#app')
sessionStorage.removeItem('preload-error-reload')
