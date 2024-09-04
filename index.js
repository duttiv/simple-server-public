const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const mariadb = require('mariadb');
const { uniqueUsernameGenerator, adjectives, nouns } = require("unique-username-generator");
const crypto = require('crypto');

const sha256 = (inputString) => {
  const hash = crypto.createHash('sha256');
  hash.update(inputString);
  return hash.digest('hex');
}

const capitalizeFirstLetter = (string) => {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

const app = express();

const port = 8080;

const host = "changeme";
const database = "changeme";
const user = "changeme";
const password = "changeme";

const pool = mariadb.createPool({
  host,
  database,
  user,
  password,
  connectionLimit: 5,
  insertIdAsNumber: true,
  supportBigNumbers: true,
});

const connectDatabase = async (callback) => {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const response = await callback(connection);
    await connection.commit();
    return response;
  }
  catch (e) {
    if (connection) {
      await connection.rollback();
    }
    throw e;
  } finally {
    if (connection) {
      await connection.end();
    }
  }
};

app.use(cors());
app.use(bodyParser.json());

const withErrorHandling = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  }
  catch (error) {
    console.error('An error occurred:', error);
    res.status(500).send('Internal Server Error');
  }
};

app.get('/api/users', withErrorHandling(async (req, res) => {
  const response = await connectDatabase(async (connection) => {
    return await connection.query(
      "SELECT id, first_name as firstName, last_name as lastName FROM user;");
  });
  res.send(response);
}));

app.get('/api/stakeholders', withErrorHandling(async (req, res) => {
  const response = await connectDatabase(async (connection) => {
    return await connection.query(
      "SELECT d.id AS id, d.name AS name, JSON_ARRAYAGG(JSON_OBJECT('id', u.id, 'firstName', u.first_name, 'lastName', u.last_name)) AS users FROM department d JOIN user_department ud ON d.id = ud.fk_department JOIN user u ON ud.fk_user = u.id GROUP BY d.id;");
  });
  res.send(response);
}));

app.get('/api/processes', withErrorHandling(async (req, res) => {
  const response = await connectDatabase(async (connection) => {
    return await connection.query("SELECT id, name FROM process;");
  });
  res.send(response);
}));

app.get('/api/data-types', withErrorHandling(async (req, res) => {
  const response = await connectDatabase(async (connection) => {
    return await connection.query("SELECT id, name, description FROM data_type;");
  });
  res.send(response);
}));

app.get('/api/quality-criteria', withErrorHandling(async (req, res) => {
  const response = await connectDatabase(async (connection) => {
    return await connection.query("SELECT id, name, description, guidelines FROM quality_criteria;");
  });
  res.send(response);
}));

app.get('/api/evaluation-period', withErrorHandling(async (req, res) => {
  const { evaluationId } = req.query;
  const response = await connectDatabase(async (connection) => {
    return await connection.query(
      `SELECT fk_period as evaluationPeriodId
       FROM evaluation
       WHERE id = ${evaluationId}`);
  });
  res.send(response);
}));

app.get('/api/user', withErrorHandling(async (req, res) => {
  const { evaluationId } = req.query;
  const response = await connectDatabase(async (connection) => {
    return await connection.query(
      `SELECT user.id, user.email, user.first_name as firstName, user.last_name as lastName
       FROM user
                INNER JOIN evaluation on evaluation.fk_user = user.id
       WHERE evaluation.id = ${evaluationId}`);
  });
  res.send(response);
}));

app.post('/api/evaluation', withErrorHandling(async (req, res) => {
  const result = await connectDatabase(async (connection) => {
    const username = uniqueUsernameGenerator({
      separator: '.',
      dictionaries: [adjectives, nouns]
    });
    const email = `${username}${Math.floor(Math.random() * 1000)}@test.net`;
    const split = username.split('.');
    const firstName = capitalizeFirstLetter(split[0]);
    const lastName = capitalizeFirstLetter(split[1]);
    const newUser = await connection.query(
      `INSERT INTO user (email, password, first_name, last_name)
       VALUES ('${email}', '${sha256(username)}', '${firstName}', '${lastName}')`);
    const userId = newUser.insertId;
    connection.query(
      `INSERT INTO user_department (fk_user, fk_department)
       VALUES ('${userId}', '${Math.floor(Math.random() * 4) + 1}')`);
    const evalPeriodId = await connection.query(
      'SELECT id FROM evaluation_period ORDER BY id DESC LIMIT 1');
    const id = evalPeriodId[0].id;
    return await connection.query(`INSERT INTO evaluation (fk_period, fk_user)
                                   VALUES (${id}, ${userId})`);
  });
  res.send({ id: result.insertId });
}));

app.get('/api/evaluation/stakeholders', withErrorHandling(async (req, res) => {
  const { evaluationPeriodId } = req.query;
  const result = await connectDatabase(async (connection) => {
    return await connection.query(`SELECT fk_user
                                   FROM evaluation
                                   WHERE fk_period = ${evaluationPeriodId};`);
  });
  res.send(result.map((evaluation) => evaluation.fk_user));
}));

app.post('/api/evaluation/stakeholders', withErrorHandling(async (req, res) => {
  const { evaluationPeriodId, users } = req.body;
  const values = users.map((userId) => [evaluationPeriodId, userId]);
  const formattedValues = values.map((value) => `(${value.join(',')})`).join(',');
  await connectDatabase(async (connection) => {
    await connection.query(`INSERT INTO evaluation (fk_period, fk_user)
                            VALUES ${formattedValues}`);
  });
  res.send();
}));

app.get('/api/evaluation/processes', withErrorHandling(async (req, res) => {
  const { evaluationId } = req.query;
  const response = await connectDatabase(async (connection) => {
    return await connection.query(`SELECT p.id, p.name, ep.id as evaluationProcessId
                                   FROM process p
                                            JOIN evaluation_process ep ON p.id = ep.fk_process
                                   WHERE ep.fk_evaluation = ${evaluationId};`);
  });
  res.send(response);
}));

app.post('/api/evaluation/processes', withErrorHandling(async (req, res) => {
  const { evaluationId, processes, newProcesses } = req.body;
  const values = processes.map((processId) => [evaluationId, processId]);
  const newInserts = [];
  await connectDatabase(async (connection) => {
    for (const newProcess of newProcesses) {
      const result = await connection.query(`INSERT INTO process (name)
                                             VALUES ('${newProcess.name}')`);
      const { insertId } = result;
      newInserts.push([evaluationId, insertId]);
    }
    const allValues = [...values, ...newInserts];
    const formattedValues = allValues.map((value) => `(${value.join(',')})`).join(',');
    await connection.query(`INSERT INTO evaluation_process (fk_evaluation, fk_process)
                            VALUES ${formattedValues}`);
  });
  res.send();
}));

app.get('/api/evaluation/data-types', withErrorHandling(async (req, res) => {
  const { evaluationId } = req.query;
  const response = await connectDatabase(async (connection) => {
    return await connection.query(`SELECT ep.fk_process AS processId, fk_data_type AS dataTypeId
                                   FROM evaluation_process_data_type
                                            JOIN evaluation_process ep
                                                 ON evaluation_process_data_type.fk_evaluation_process = ep.id
                                   WHERE ep.fk_evaluation = ${evaluationId};`);
  });
  res.send(response);
}));

app.post('/api/evaluation/data-types', withErrorHandling(async (req, res) => {
  const { data } = req.body;
  const values = data.map((val) => [val.evaluationProcessId, val.dataTypeId]);
  const formattedValues = values.map((value) => `(${value.join(',')})`).join(',');
  await connectDatabase(async (connection) => {
    await connection.query(`INSERT INTO evaluation_process_data_type (fk_evaluation_process, fk_data_type)
                            VALUES ${formattedValues}`);
  });
  res.send();
}));

app.get('/api/evaluation/scores/data-types', withErrorHandling(async (req, res) => {
  const { evaluationId } = req.query;
  const response = await connectDatabase(async (connection) => {
    return await connection.query(`SELECT dt.id, dt.name, dt.description, count(dt.id) as count
                                   from data_type dt
                                            JOIN evaluation_process_data_type epdt
                                                 on dt.id = epdt.fk_data_type
                                            JOIN evaluation_process ev on epdt.fk_evaluation_process = ev.id
                                            JOIN evaluation e on ev.fk_evaluation = e.id
                                   WHERE e.fk_period =
                                         (SELECT fk_period from evaluation where id = ${evaluationId})
                                   GROUP BY dt.id
                                   ORDER BY count desc
                                   LIMIT 5;`);
  });
  res.send(response);
}));

app.get('/api/evaluation/scores', withErrorHandling(async (req, res) => {
  const { evaluationId } = req.query;
  const result = await connectDatabase(async (connection) => {
    return await connection.query(`SELECT fk_data_type as dataTypeId,
                                          fk_criteria  as criteriaId,
                                          score        as value
                                   FROM evaluation_data_type_criteria_score
                                   WHERE fk_evaluation = ${evaluationId}`);
  });
  const response = {};
  result.forEach((score) => {
    const criteriaScores = Object.keys(response)
    .includes(score.criteriaId) ? { ...response[score.criteriaId] } : {};
    criteriaScores[score.dataTypeId] = score.value;
    response[score.criteriaId] = { ...response[score.criteriaId], ...criteriaScores };
  });
  res.send(response);
}));

app.post('/api/evaluation/scores', withErrorHandling(async (req, res) => {
  const { evaluationId, scores } = req.body;
  const evaluations = [];
  Object.keys(scores).forEach((criteriaId) => {
    const criteriaDataTypeScores = scores[criteriaId];
    const dataTypeIds = Object.keys(criteriaDataTypeScores);
    dataTypeIds.forEach((dataTypeId) => {
      evaluations.push([evaluationId, dataTypeId, criteriaId, criteriaDataTypeScores[dataTypeId]]);
    })
  });
  const formattedValues = evaluations.map((value) => `(${value.join(',')})`).join(',');
  await connectDatabase(async (connection) => {
    await connection.query(`INSERT INTO evaluation_data_type_criteria_score (fk_evaluation, fk_data_type, fk_criteria, score)
                            VALUES ${formattedValues}`);
    await connection.query(`UPDATE evaluation
                            SET completed = 1
                            WHERE id = ${evaluationId};`);
  });
  res.send();
}));

app.get('/api/evaluation/results', withErrorHandling(async (req, res) => {
  const { evaluationId } = req.query;
  const result = await connectDatabase(async (connection) => {
    return await connection.query(`SELECT edtcs.fk_data_type as dataTypeId,
                                          edtcs.fk_criteria  as criteriaId,
                                          SUM(edtcs.score)   as value
                                   FROM evaluation_data_type_criteria_score edtcs
                                            JOIN evaluation e on edtcs.fk_evaluation = e.id
                                   WHERE e.fk_period = (SELECT fk_period
                                                        FROM evaluation ev
                                                        WHERE ev.id = ${evaluationId})
                                   GROUP BY fk_data_type, fk_criteria;`);
  });
  const response = {};
  result.forEach((score) => {
    const criteriaScores = Object.keys(response)
    .includes(score.criteriaId) ? { ...response[score.criteriaId] } : {};
    criteriaScores[score.dataTypeId] = score.value;
    response[score.criteriaId] = { ...response[score.criteriaId], ...criteriaScores };
  });
  res.send(response);
}));

app.get('/api/evaluation/total-evaluations', withErrorHandling(async (req, res) => {
  const { evaluationId } = req.query;
  const response = await connectDatabase(async (connection) => {
    return await connection.query(`SELECT count(*) as total
                                   FROM evaluation
                                   WHERE fk_period = (SELECT e.fk_period
                                                      FROM evaluation e
                                                      WHERE e.id = ${evaluationId})
                                     AND completed = 1;`);
  });
  res.send({ total: response.length > 0 ? response[0].total : 1 });
}));

app.get('/api/evaluation/summary/data-types', withErrorHandling(async (req, res) => {
  const { evaluationId } = req.query;
  const response = await connectDatabase(async (connection) => {
    return await connection.query(`SELECT dt.id,
                                          dt.name,
                                          count(*)                    AS priority,
                                          sum(edtcs.score),
                                          sum(edtcs.score) / count(*) AS calculatedScore
                                   FROM data_type dt
                                            JOIN evaluation_process_data_type epdt
                                                 ON dt.id = epdt.fk_data_type
                                            JOIN evaluation_data_type_criteria_score edtcs
                                                 ON dt.id = edtcs.fk_data_type
                                            JOIN evaluation_process ep ON epdt.fk_evaluation_process = ep.id
                                            JOIN evaluation e ON edtcs.fk_evaluation = e.id
                                   WHERE e.fk_period =
                                         (SELECT fk_period FROM evaluation WHERE id = ${evaluationId})
                                     AND e.completed = 1
                                   GROUP BY dt.id
                                   ORDER BY priority DESC;`);
  });
  res.send(response);
}));

app.get('/api/evaluation/summary/quality-criteria', withErrorHandling(async (req, res) => {
  const { evaluationId } = req.query;
  const response = await connectDatabase(async (connection) => {
    return await connection.query(`SELECT criteria.id,
                                          criteria.name,
                                          count(*)                    AS priority,
                                          sum(edtcs.score),
                                          sum(edtcs.score) / count(*) AS calculatedScore
                                   FROM quality_criteria criteria
                                            JOIN evaluation_data_type_criteria_score edtcs
                                                 ON criteria.id = edtcs.fk_criteria
                                            JOIN evaluation e ON edtcs.fk_evaluation = e.id
                                   WHERE e.fk_period =
                                         (SELECT fk_period FROM evaluation WHERE id = ${evaluationId})
                                     AND e.completed = 1
                                   GROUP BY criteria.id
                                   ORDER BY priority DESC;`);
  });
  res.send(response);
}));

app.get('/api/evaluation/actions', withErrorHandling(withErrorHandling(async (req, res) => {
  const { evaluationPeriodId } = req.query;
  const response = await connectDatabase(async (connection) => {
    return await connection.query(`SELECT id, activity, fk_user as userId, status
                                   FROM evaluation_action
                                   WHERE fk_period = ${evaluationPeriodId}`);
  });
  res.send(response);
})));

app.post('/api/evaluation/actions', withErrorHandling(async (req, res) => {
  const { evaluationPeriodId, actions } = req.body;
  const values = actions.map(action => [action.activity, evaluationPeriodId, action.userId]);

  // Create a string for the placeholders - each set of values in the array needs a tuple placeholder
  const placeholders = values.map(() => '(?, ?, ?)').join(', ');

  await connectDatabase(async (connection) => {
    await connection.query(`INSERT INTO evaluation_action (activity, fk_period, fk_user)
                            VALUES ${placeholders}`, [].concat(...values));
  });
  res.send();
}));

app.get('/api', async (req, res) => {
  res.send('Hello from our server!')
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`)
});
