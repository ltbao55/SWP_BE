const express = require('express');
const router = express.Router();

// This route can be used for label-related operations
// Currently labels are stored in tasks, but this can be extended

router.get('/', (req, res) => {
  res.json({ message: 'Labels endpoint' });
});

module.exports = router;
