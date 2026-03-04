import React from 'react'
import ReactDOM from 'react-dom/client'
import { OnchainKitProvider } from "@coinbase/onchainkit";
import { base } from "wagmi/chains";
import App from './app.jsx'
import './app.css'
import "@coinbase/onchainkit/styles.css";

const onchainKitApiKey = import.meta.env.VITE_PUBLIC_ONCHAINKIT_API_KEY;

ReactDOM.createRoot(document.getElementById('app')).render(
  <OnchainKitProvider
    apiKey={onchainKitApiKey}
    chain={base}
    miniKit={{ enabled: true }}
  >
    <App />
  </OnchainKitProvider>
)
