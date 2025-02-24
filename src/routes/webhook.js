import express from 'express';
import { handleWapiWebhook } from '../controllers/channels/wapi.js';
import { handleWhatsAppOfficialWebhook } from '../controllers/channels/whatsapp-official.js';
import { handleInstagramWebhook } from '../controllers/channels/instagram.js';
import { handleFacebookWebhook } from '../controllers/channels/facebook.js';

const router = express.Router({ mergeParams: true });

// WhatsApp WApi routes
router.post('/wapi/:channelId', handleWapiWebhook);
router.get('/wapi/:channelId', handleWapiWebhook);

// WhatsApp Official API webhook handler
router.post('/whatsapp-official/:channelId', handleWhatsAppOfficialWebhook);

// Instagram webhook handler
router.post('/instagram/:channelId', handleInstagramWebhook);

// Facebook webhook handler
router.post('/facebook/:channelId', handleFacebookWebhook);

export default router;