
import axios from 'axios';
import * as cheerio from 'cheerio';
import { extractBrandMetadata } from '../utils/brandScraper.js';

const url = 'https://uwo24.com';

async function test() {
    try {
        console.log('Testing extraction for:', url);
        const data = await extractBrandMetadata(url);
        console.log('--- TEST RESULTS ---');
        console.log('Brand Name:', data.brandName);
        console.log('Logo URL:', data.logoUrl);
        console.log('Brand Colors:', data.brandColors);
    } catch (e) {
        console.error('Error during extraction:', e);
    }
}

test();
