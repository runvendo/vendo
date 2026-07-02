import messagesArray from "../../data";

// const [data] = useState(DATA);
// const [currentPage, setCurrentPage] = useState(1);
// const [pageLimit] = useState(15);
let pageLimit = 17;

export const changePageNumber = (pagenumber) => {
  const indexOfLastPost = pagenumber * pageLimit;
  const indexOfFirstPost = indexOfLastPost - pageLimit;

  let currentMessages = null;

  currentMessages = messagesArray.slice(indexOfFirstPost, indexOfLastPost);
  // console.log(currentMessages);
  // console.log(data);
  // console.log(currentPage);

  return currentMessages;
};

// const paginate = (pageNumber) => setCurrentPage(pageNumber);
