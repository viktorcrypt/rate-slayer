import React from 'react'
import ReactDOM from 'react-dom/client'
import { MiniKitProvider } from "@coinbase/onchainkit/minikit";
import { base } from "wagmi/chains";
import App from './app.jsx'
import './app.css'
import "@coinbase/onchainkit/styles.css";

const onchainKitApiKey = import.meta.env.VITE_PUBLIC_ONCHAINKIT_API_KEY;

ReactDOM.createRoot(document.getElementById('app')).render(
  <React.StrictMode>
    <MiniKitProvider
      apiKey={onchainKitApiKey}
      chain={base}
      autoConnect={true}
      notificationProxyUrl="/api/notify"
    >
      <App />
    </MiniKitProvider>
  </React.StrictMode>,
)