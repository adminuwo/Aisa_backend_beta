import axios from 'axios';
import FormData from 'form-data';

async function test() {
  try {
    // 1. We need to login or mock it
    // Wait, we can't easily mock auth unless we create a JWT token.
    console.log('Skipping local POST because of auth');
  } catch (e) {
    console.log(e);
  }
}

test();
