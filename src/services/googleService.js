const { google } = require('googleapis');
const axios = require('axios');
const { encrypt, decrypt } = require('../utils/encryption');
const User = require('../models/User');

class GoogleService {
  static getOAuth2Client() {
    return new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
  }

  static getAuthUrl(state) {
    const oauth2Client = this.getOAuth2Client();
    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: ['https://www.googleapis.com/auth/business.manage'],
      state: state
    });
  }

  static async exchangeCode(code) {
    const oauth2Client = this.getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    return tokens;
  }

  static async getLocations(accessToken) {
    try {
      const accountsRes = await axios.get(
        'https://mybusinessaccountmanagement.googleapis.com/v1/accounts',
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const accounts = accountsRes.data.accounts || [];
      const locations = [];
      for (const account of accounts) {
        try {
          const locsRes = await axios.get(
            `https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations`,
            {
              headers: { Authorization: `Bearer ${accessToken}` },
              params: { readMask: 'name,title,metadata' }
            }
          );
          for (const loc of (locsRes.data.locations || [])) {
            locations.push({
              accountName: account.name,
              locationName: loc.name,
              title: loc.title,
              placeId: loc.metadata?.placeId
            });
          }
        } catch (locErr) {
          console.error(`Error fetching locations for ${account.name}:`, locErr.message);
        }
      }
      return locations;
    } catch (error) {
      console.error('Error getting locations:', error.response?.data || error.message);
      throw error;
    }
  }

  static async getReviews(user) {
    const accessToken = await this.getValidToken(user);
    if (!accessToken || !user.googleAccountName || !user.googleLocationName) {
      throw new Error('Google not properly linked');
    }
    try {
      const reviewsRes = await axios.get(
        `https://mybusiness.googleapis.com/v4/${user.googleAccountName}/${user.googleLocationName}/reviews`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: { pageSize: 50 }
        }
      );
      return reviewsRes.data.reviews || [];
    } catch (error) {
      console.error('Error fetching reviews:', error.response?.data || error.message);
      throw error;
    }
  }

  static async replyToReview(user, googleReviewId, responseText) {
    const accessToken = await this.getValidToken(user);
    try {
      const res = await axios.put(
        `https://mybusiness.googleapis.com/v4/${googleReviewId}/reply`,
        { comment: responseText },
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      return res.data;
    } catch (error) {
      console.error('Error replying to review:', error.response?.data || error.message);
      throw error;
    }
  }

  static async getValidToken(user) {
    if (!user.googleAccessToken) return null;
    const accessToken = decrypt(user.googleAccessToken);
    if (user.tokenExpiresAt && new Date(user.tokenExpiresAt) < new Date()) {
      return await this.refreshToken(user);
    }
    return accessToken;
  }

  static async refreshToken(user) {
    const refreshToken = decrypt(user.googleRefreshToken);
    if (!refreshToken) throw new Error('No refresh token available');
    try {
      const response = await axios.post('https://oauth2.googleapis.com/token', {
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      });
      const newAccessToken = response.data.access_token;
      user.googleAccessToken = encrypt(newAccessToken);
      user.tokenExpiresAt = new Date(Date.now() + response.data.expires_in * 1000);
      await user.save();
      console.log(`Token refreshed for: ${user.email}`);
      return newAccessToken;
    } catch (error) {
      console.error('Token refresh failed:', error.message);
      throw error;
    }
  }

  static async saveTokens(userId, tokens, locationData) {
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');
    user.googleAccessToken = encrypt(tokens.access_token);
    if (tokens.refresh_token) {
      user.googleRefreshToken = encrypt(tokens.refresh_token);
    }
    user.tokenExpiresAt = new Date(Date.now() + (tokens.expiry_date || 3600000));
    user.googleLinkedAt = new Date();
    if (locationData) {
      user.googleAccountName = locationData.accountName;
      user.googleLocationName = locationData.locationName;
      user.googleBusinessName = locationData.title;
      user.googlePlaceId = locationData.placeId;
    }
    await user.save();
    return user;
  }
}

module.exports = GoogleService;
